/**
 * indexer.js — Backfill proposals from on-chain logs + live monitoring
 *
 * Implements FR-3 (proposal discovery), FR-4 (recover txHashes), and Section 7 of the SRD.
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import {
  MODULE_ADDRESS,
  REALITIO_ADDRESS,
  LOG_CHUNK_SIZE,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  SECONDS_PER_DAY,
} from "./config.js";
import {
  moduleIface,
  realitioIface,
  getModuleContract,
  topicHash,
} from "./contracts.js";
import { dbPut, dbGetAll, getSetting, setSetting } from "./db.js";

let _pollTimer = null;

// ---- Helpers ----

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper for RPC calls.
 */
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) await sleep(RETRY_DELAY_MS * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * Estimate a block number that is approximately `secondsAgo` before latest.
 * Uses binary search on block timestamps.
 */
export async function estimateBlockFromTime(provider, secondsAgo) {
  const latest = await provider.getBlock("latest");
  const targetTs = latest.timestamp - secondsAgo;

  // Quick estimate assuming ~12s blocks on mainnet
  const estimatedBlocks = Math.ceil(secondsAgo / 12);
  let lo = Math.max(0, latest.number - estimatedBlocks * 2);
  let hi = latest.number;

  // Binary search for closer accuracy
  for (let i = 0; i < 15; i++) {
    if (lo >= hi) break;
    const mid = Math.floor((lo + hi) / 2);
    const block = await withRetry(() => provider.getBlock(mid));
    if (!block) { lo = mid + 1; continue; }
    if (block.timestamp < targetTs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Fetch logs in chunked ranges to avoid RPC limits.
 */
async function getLogsChunked(provider, filter, fromBlock, toBlock, onProgress) {
  const allLogs = [];
  let current = fromBlock;
  const total = toBlock - fromBlock;

  while (current <= toBlock) {
    const end = Math.min(current + LOG_CHUNK_SIZE - 1, toBlock);
    const logs = await withRetry(() =>
      provider.getLogs({ ...filter, fromBlock: current, toBlock: end })
    );
    allLogs.push(...logs);
    current = end + 1;

    if (onProgress) {
      const pct = Math.min(100, Math.round(((current - fromBlock) / total) * 100));
      onProgress(pct, allLogs.length);
    }
  }
  return allLogs;
}

/**
 * Backfill proposals from the Reality Module.
 * Scans ProposalQuestionCreated events, recovers txHashes from addProposal call input,
 * and builds question text via the module's buildQuestion view.
 */
export async function backfillProposals(provider, backfillDays, onProgress) {
  const secondsAgo = backfillDays * SECONDS_PER_DAY;
  const fromBlock = await estimateBlockFromTime(provider, secondsAgo);
  const latestBlock = await provider.getBlockNumber();

  if (onProgress) onProgress(0, 0, "Scanning proposal events...");

  const filter = {
    address: MODULE_ADDRESS,
    topics: [topicHash(moduleIface, "ProposalQuestionCreated")],
  };

  const logs = await getLogsChunked(provider, filter, fromBlock, latestBlock, (pct, count) => {
    if (onProgress) onProgress(pct, count, `Scanning blocks... ${pct}%`);
  });

  if (onProgress) onProgress(100, logs.length, `Found ${logs.length} proposals. Enriching...`);

  const moduleContract = getModuleContract(provider);
  const proposals = [];

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    try {
      const parsed = moduleIface.parseLog({ topics: log.topics, data: log.data });
      const questionId = parsed.args[0]; // questionId (bytes32)
      // proposalId is indexed as a string topic — it's the keccak hash, need to get from tx
      let proposalId = "";
      let txHashes = [];
      let questionText = "";

      // Decode addProposal call input to get proposalId + txHashes
      try {
        const tx = await withRetry(() => provider.getTransaction(log.transactionHash));
        if (tx && tx.data) {
          const decoded = moduleIface.parseTransaction({ data: tx.data, value: tx.value });
          if (decoded && decoded.name === "addProposal") {
            proposalId = decoded.args[0];
            txHashes = Array.from(decoded.args[1]);
          }
        }
      } catch (e) {
        console.warn(`Could not decode tx input for ${log.transactionHash}:`, e.message);
      }

      // Build question text from module
      if (txHashes.length > 0 && proposalId) {
        try {
          questionText = await withRetry(() =>
            moduleContract.buildQuestion(proposalId, txHashes)
          );
        } catch (e) {
          console.warn(`Could not buildQuestion for ${proposalId}:`, e.message);
        }
      }

      // Get block timestamp
      let createdTimestamp = 0;
      try {
        const block = await withRetry(() => provider.getBlock(log.blockNumber));
        createdTimestamp = block ? block.timestamp : 0;
      } catch { /* skip */ }

      const proposal = {
        questionId: questionId,
        proposalId: proposalId,
        txHashes: txHashes,
        questionText: questionText,
        createdBlock: log.blockNumber,
        createdTxHash: log.transactionHash,
        createdTimestamp: createdTimestamp,
      };

      // Store in IndexedDB
      await dbPut("proposals", proposal);
      proposals.push(proposal);

      if (onProgress) {
        onProgress(
          100,
          logs.length,
          `Enriching proposal ${i + 1}/${logs.length}...`
        );
      }
    } catch (err) {
      console.error(`Error processing proposal log:`, err);
    }
  }

  // Save last processed block
  await setSetting("lastProcessedBlock", latestBlock);

  return proposals;
}

/**
 * Fetch new proposals since last processed block.
 */
export async function fetchNewProposals(provider) {
  const lastBlock = (await getSetting("lastProcessedBlock")) || 0;
  const latestBlock = await provider.getBlockNumber();

  if (latestBlock <= lastBlock) return [];

  const filter = {
    address: MODULE_ADDRESS,
    topics: [topicHash(moduleIface, "ProposalQuestionCreated")],
  };

  const logs = await getLogsChunked(provider, filter, lastBlock + 1, latestBlock);
  const moduleContract = getModuleContract(provider);
  const newProposals = [];

  for (const log of logs) {
    try {
      const parsed = moduleIface.parseLog({ topics: log.topics, data: log.data });
      const questionId = parsed.args[0];
      let proposalId = "";
      let txHashes = [];
      let questionText = "";

      try {
        const tx = await withRetry(() => provider.getTransaction(log.transactionHash));
        if (tx && tx.data) {
          const decoded = moduleIface.parseTransaction({ data: tx.data, value: tx.value });
          if (decoded && decoded.name === "addProposal") {
            proposalId = decoded.args[0];
            txHashes = Array.from(decoded.args[1]);
          }
        }
      } catch { /* skip */ }

      if (txHashes.length > 0 && proposalId) {
        try {
          questionText = await withRetry(() =>
            moduleContract.buildQuestion(proposalId, txHashes)
          );
        } catch { /* skip */ }
      }

      let createdTimestamp = 0;
      try {
        const block = await withRetry(() => provider.getBlock(log.blockNumber));
        createdTimestamp = block ? block.timestamp : 0;
      } catch { /* skip */ }

      const proposal = {
        questionId,
        proposalId,
        txHashes,
        questionText,
        createdBlock: log.blockNumber,
        createdTxHash: log.transactionHash,
        createdTimestamp,
      };

      await dbPut("proposals", proposal);
      newProposals.push(proposal);
    } catch (err) {
      console.error("Error in live update:", err);
    }
  }

  await setSetting("lastProcessedBlock", latestBlock);
  return newProposals;
}

/**
 * Fetch answer events for a specific questionId.
 */
export async function fetchAnswerHistory(provider, questionId) {
  const fromBlock = 0; // Ideally use proposal's createdBlock
  const latestBlock = await provider.getBlockNumber();

  // Get proposal to know which block it was created in
  const proposals = await dbGetAll("proposals");
  const proposal = proposals.find((p) => p.questionId === questionId);
  const startBlock = proposal ? proposal.createdBlock : Math.max(0, latestBlock - 50000);

  // LogNewAnswer event signature:
  //   event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)
  // question_id is the FIRST indexed param (topic[1]), user is second indexed (topic[2])
  const logs = await getLogsChunked(provider, {
    address: REALITIO_ADDRESS,
    topics: [
      topicHash(realitioIface, "LogNewAnswer"),
      questionId, // question_id is indexed as topic[1]
    ],
  }, startBlock, latestBlock);

  // Filter for our questionId (since topic filtering may vary)
  const answers = [];
  for (const log of logs) {
    try {
      const parsed = realitioIface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      // question_id is the second indexed param
      const logQuestionId = parsed.args.question_id || parsed.args[1];
      if (logQuestionId.toLowerCase() !== questionId.toLowerCase()) continue;

      const answer = {
        id: `${questionId}:${log.blockNumber}:${log.transactionIndex}:${log.index}`,
        questionId: questionId,
        answer: parsed.args.answer || parsed.args[0],
        historyHash: parsed.args.history_hash || parsed.args[2],
        user: parsed.args.user || parsed.args[3],
        bond: parsed.args.bond?.toString() || parsed.args[4]?.toString() || "0",
        ts: Number(parsed.args.ts || parsed.args[5] || 0),
        isCommitment: parsed.args.is_commitment || parsed.args[6] || false,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };

      await dbPut("answers", answer);
      answers.push(answer);
    } catch { /* skip unparseable */ }
  }

  return answers;
}

/**
 * Start live polling for new proposals + state updates.
 */
export function startPolling(provider, intervalSec, onNewData) {
  stopPolling();
  _pollTimer = setInterval(async () => {
    try {
      const newProposals = await fetchNewProposals(provider);
      if (onNewData) onNewData(newProposals);
    } catch (err) {
      console.error("Polling error:", err);
    }
  }, intervalSec * 1000);
}

/**
 * Stop live polling.
 */
export function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
