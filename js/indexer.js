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
  MAX_BACKOFF_DELAY_MS,
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
let _rpcFailureHandler = null;

// ---- Helpers ----

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function setRpcFailureHandler(handler) {
  _rpcFailureHandler = typeof handler === "function" ? handler : null;
}

/**
 * Retry wrapper for RPC calls with exponential backoff.
 */
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  let delayMs = RETRY_DELAY_MS;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        await sleep(Math.min(delayMs, MAX_BACKOFF_DELAY_MS));
        delayMs = Math.min(delayMs * 2, MAX_BACKOFF_DELAY_MS);
      }
    }
  }

  if (_rpcFailureHandler) {
    try {
      await _rpcFailureHandler(lastErr);
    } catch (handlerErr) {
      console.warn("RPC failure handler error:", handlerErr?.message || handlerErr);
    }
  }

  throw lastErr;
}

/**
 * Estimate a block number that is approximately `secondsAgo` before latest.
 * Uses binary search on block timestamps.
 */
export async function estimateBlockFromTime(provider, secondsAgo) {
  const latest = await withRetry(() => provider.getBlock("latest"));
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
    if (!block) {
      lo = mid + 1;
      continue;
    }
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
  if (toBlock < fromBlock) return [];

  const allLogs = [];
  let current = fromBlock;
  const totalSpan = Math.max(1, toBlock - fromBlock + 1);

  while (current <= toBlock) {
    const end = Math.min(current + LOG_CHUNK_SIZE - 1, toBlock);
    const logs = await withRetry(() =>
      provider.getLogs({ ...filter, fromBlock: current, toBlock: end })
    );
    allLogs.push(...logs);
    current = end + 1;

    if (onProgress) {
      const scanned = end - fromBlock + 1;
      const pct = Math.min(100, Math.round((scanned / totalSpan) * 100));
      onProgress(pct, allLogs.length);
    }
  }

  return allLogs;
}

function normalizeProposalId(proposalId) {
  return (proposalId || "").trim().toLowerCase();
}

async function decodeProposalFromLog(provider, moduleContract, log) {
  const parsed = moduleIface.parseLog({ topics: log.topics, data: log.data });
  const questionId = parsed.args[0];

  let proposalId = "";
  let txHashes = [];
  let questionText = "";

  // Decode addProposal call input to recover proposalId + txHashes
  try {
    const tx = await withRetry(() => provider.getTransaction(log.transactionHash));
    if (tx && tx.data) {
      const decoded = moduleIface.parseTransaction({ data: tx.data, value: tx.value });
      if (decoded && decoded.name === "addProposal") {
        proposalId = decoded.args[0];
        txHashes = Array.from(decoded.args[1]);
      }
    }
  } catch (err) {
    console.warn(`Could not decode tx input for ${log.transactionHash}:`, err.message);
  }

  // Build question text from module
  if (txHashes.length > 0 && proposalId) {
    try {
      questionText = await withRetry(() => moduleContract.buildQuestion(proposalId, txHashes));
    } catch (err) {
      console.warn(`Could not buildQuestion for ${proposalId}:`, err.message);
    }
  }

  // Block timestamp for table display
  let createdTimestamp = 0;
  try {
    const block = await withRetry(() => provider.getBlock(log.blockNumber));
    createdTimestamp = block ? block.timestamp : 0;
  } catch {
    // ignore timestamp failures
  }

  return {
    questionId,
    proposalId,
    txHashes,
    questionText,
    createdBlock: log.blockNumber,
    createdTxHash: log.transactionHash,
    createdTimestamp,
  };
}

async function scanProposalsInRange(provider, fromBlock, toBlock, onProgress) {
  if (toBlock < fromBlock) return [];

  const filter = {
    address: MODULE_ADDRESS,
    topics: [topicHash(moduleIface, "ProposalQuestionCreated")],
  };

  if (onProgress) onProgress(0, 0, "Scanning proposal events...");
  const logs = await getLogsChunked(provider, filter, fromBlock, toBlock, (pct, count) => {
    if (onProgress) onProgress(pct, count, `Scanning proposal logs... ${pct}%`);
  });

  if (onProgress) onProgress(100, logs.length, `Found ${logs.length} proposals. Enriching...`);

  const moduleContract = getModuleContract(provider);
  const proposals = [];

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    try {
      const proposal = await decodeProposalFromLog(provider, moduleContract, log);
      await dbPut("proposals", proposal);
      proposals.push(proposal);

      if (onProgress) {
        onProgress(100, logs.length, `Enriching proposal ${i + 1}/${logs.length}...`);
      }
    } catch (err) {
      console.error("Error processing proposal log:", err);
    }
  }

  return proposals;
}

async function indexAnswersInRange(provider, fromBlock, toBlock, onProgress) {
  if (toBlock < fromBlock) return 0;

  const filter = {
    address: REALITIO_ADDRESS,
    topics: [topicHash(realitioIface, "LogNewAnswer")],
  };

  if (onProgress) onProgress(0, 0, "Scanning answer events...");
  const logs = await getLogsChunked(provider, filter, fromBlock, toBlock, (pct, count) => {
    if (onProgress) onProgress(pct, count, `Scanning answer logs... ${pct}%`);
  });

  let parsedCount = 0;
  for (const log of logs) {
    try {
      const parsed = realitioIface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;

      const questionId = parsed.args.question_id || parsed.args[1];
      const answer = {
        id: `${questionId}:${log.blockNumber}:${log.transactionIndex}:${log.index}`,
        questionId,
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
      parsedCount += 1;
    } catch {
      // skip malformed events
    }
  }

  return parsedCount;
}

/**
 * Backfill answer events in a specific block range.
 */
export async function backfillAnswerHistory(provider, fromBlock, toBlock, onProgress) {
  return indexAnswersInRange(provider, fromBlock, toBlock, onProgress);
}

async function updateIndexedRangeSettings(fromBlock, toBlock) {
  const earliest = await getSetting("earliestIndexedBlock");
  if (earliest === null || earliest === undefined) {
    await setSetting("earliestIndexedBlock", fromBlock);
  } else {
    await setSetting("earliestIndexedBlock", Math.min(Number(earliest), fromBlock));
  }

  const lastProcessed = Number((await getSetting("lastProcessedBlock")) || 0);
  await setSetting("lastProcessedBlock", Math.max(lastProcessed, toBlock));
}

/**
 * Backfill proposals from the Reality Module for a day-based window.
 */
export async function backfillProposals(provider, backfillDays, onProgress) {
  const secondsAgo = backfillDays * SECONDS_PER_DAY;
  const fromBlock = await estimateBlockFromTime(provider, secondsAgo);
  const latestBlock = await withRetry(() => provider.getBlockNumber());

  return backfillProposalsRange(provider, fromBlock, latestBlock, onProgress);
}

/**
 * Backfill proposals (and answer logs) in an explicit block range.
 */
export async function backfillProposalsRange(provider, fromBlock, toBlock, onProgress) {
  if (toBlock < fromBlock) return [];

  const proposals = await scanProposalsInRange(provider, fromBlock, toBlock, onProgress);

  if (onProgress) onProgress(100, proposals.length, "Indexing answer history...");
  await indexAnswersInRange(provider, fromBlock, toBlock);

  await updateIndexedRangeSettings(fromBlock, toBlock);
  return proposals;
}

/**
 * Fetch newly created proposals + answer logs since the last processed block.
 */
export async function fetchNewProposals(provider) {
  const lastBlock = Number((await getSetting("lastProcessedBlock")) || 0);
  const latestBlock = await withRetry(() => provider.getBlockNumber());

  if (latestBlock <= lastBlock) return [];

  const fromBlock = lastBlock + 1;
  const newProposals = await scanProposalsInRange(provider, fromBlock, latestBlock);
  await indexAnswersInRange(provider, fromBlock, latestBlock);

  await updateIndexedRangeSettings(fromBlock, latestBlock);
  return newProposals;
}

/**
 * Fetch answer events for a specific questionId and cache them.
 */
export async function fetchAnswerHistory(provider, questionId) {
  const latestBlock = await withRetry(() => provider.getBlockNumber());

  // Use proposal creation block if known
  const proposals = await dbGetAll("proposals");
  const proposal = proposals.find((p) => p.questionId === questionId);
  const startBlock = proposal ? proposal.createdBlock : Math.max(0, latestBlock - 50000);

  const logs = await getLogsChunked(
    provider,
    {
      address: REALITIO_ADDRESS,
      topics: [topicHash(realitioIface, "LogNewAnswer"), questionId],
    },
    startBlock,
    latestBlock
  );

  const answers = [];
  for (const log of logs) {
    try {
      const parsed = realitioIface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;

      const logQuestionId = (parsed.args.question_id || parsed.args[1] || "").toLowerCase();
      if (logQuestionId !== questionId.toLowerCase()) continue;

      const answer = {
        id: `${questionId}:${log.blockNumber}:${log.transactionIndex}:${log.index}`,
        questionId,
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
    } catch {
      // skip malformed events
    }
  }

  return answers;
}

/**
 * Find and index a proposal by proposalId, scanning all history if needed.
 */
export async function findProposalById(provider, proposalId, onProgress) {
  const target = normalizeProposalId(proposalId);
  if (!target) return null;

  const latestBlock = await withRetry(() => provider.getBlockNumber());
  const eventTopic = topicHash(moduleIface, "ProposalQuestionCreated");
  const moduleContract = getModuleContract(provider);

  // First attempt: indexed proposal hash topic filter
  const hashedLogs = await getLogsChunked(
    provider,
    {
      address: MODULE_ADDRESS,
      topics: [eventTopic, null, ethers.id(proposalId)],
    },
    0,
    latestBlock,
    (pct, count) => {
      if (onProgress) onProgress(pct, count, `Searching by indexed proposal hash... ${pct}%`);
    }
  );

  for (const log of hashedLogs) {
    try {
      const proposal = await decodeProposalFromLog(provider, moduleContract, log);
      await dbPut("proposals", proposal);
      if (normalizeProposalId(proposal.proposalId) === target) {
        await fetchAnswerHistory(provider, proposal.questionId);
        return proposal;
      }
    } catch {
      // continue
    }
  }

  // Fallback: full event scan + tx input decode
  const allLogs = await getLogsChunked(
    provider,
    {
      address: MODULE_ADDRESS,
      topics: [eventTopic],
    },
    0,
    latestBlock,
    (pct, count) => {
      if (onProgress) onProgress(pct, count, `Deep scan across all proposal logs... ${pct}%`);
    }
  );

  for (let i = 0; i < allLogs.length; i++) {
    const log = allLogs[i];
    try {
      const proposal = await decodeProposalFromLog(provider, moduleContract, log);
      await dbPut("proposals", proposal);

      if (normalizeProposalId(proposal.proposalId) === target) {
        await fetchAnswerHistory(provider, proposal.questionId);
        return proposal;
      }

      if (onProgress && i % 25 === 0) {
        onProgress(100, i + 1, `Decoded ${i + 1}/${allLogs.length} proposal tx inputs...`);
      }
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Start live polling for new proposals + answer events.
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
