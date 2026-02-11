/**
 * claim.js — Bond claiming for Reality.eth questions
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import { REALITIO_ADDRESS } from "./config.js";
import { dbGetAll } from "./db.js";
import { getRealitioContract, realitioIface, topicHash } from "./contracts.js";

const DEFAULT_LOOKBACK_BLOCKS = 100000;
const LOG_CHUNK = 5000;

async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const allLogs = [];
  let current = fromBlock;

  while (current <= toBlock) {
    const end = Math.min(current + LOG_CHUNK - 1, toBlock);
    // eslint-disable-next-line no-await-in-loop
    const logs = await provider.getLogs({ ...filter, fromBlock: current, toBlock: end });
    allLogs.push(...logs);
    current = end + 1;
  }

  return allLogs;
}

/**
 * Fetch the full ordered answer history for a question from on-chain events.
 * Returns answers sorted chronologically (oldest first), each with history_hash.
 */
export async function getFullAnswerHistory(provider, questionId, fromBlock = 0) {
  const latestBlock = await provider.getBlockNumber();

  if (fromBlock === 0) {
    try {
      const proposals = await dbGetAll("proposals");
      const proposal = proposals.find((p) => p.questionId === questionId);
      if (proposal && proposal.createdBlock) {
        fromBlock = proposal.createdBlock;
      } else {
        fromBlock = Math.max(0, latestBlock - DEFAULT_LOOKBACK_BLOCKS);
      }
    } catch {
      fromBlock = Math.max(0, latestBlock - DEFAULT_LOOKBACK_BLOCKS);
    }
  }

  const filter = {
    address: REALITIO_ADDRESS,
    topics: [topicHash(realitioIface, "LogNewAnswer"), questionId],
  };

  const logs = await getLogsChunked(provider, filter, fromBlock, latestBlock);

  const answers = [];
  for (const log of logs) {
    try {
      const parsed = realitioIface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;

      answers.push({
        answer: parsed.args.answer || parsed.args[0],
        questionId,
        historyHash: parsed.args.history_hash || parsed.args[2],
        user: parsed.args.user || parsed.args[3],
        bond: (parsed.args.bond || parsed.args[4])?.toString() || "0",
        ts: Number(parsed.args.ts || parsed.args[5] || 0),
        isCommitment: parsed.args.is_commitment || parsed.args[6] || false,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      });
    } catch {
      // skip unparseable
    }
  }

  answers.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });

  return answers;
}

/**
 * Determine which answers are claimable for a specific user.
 */
export function computeClaimableAnswers(answerHistory, questionState, userAddress) {
  if (!answerHistory || answerHistory.length === 0) return [];
  if (!userAddress) return [];

  const userLower = userAddress.toLowerCase();
  const results = [];

  const isFinalized = questionState?.isFinalized || false;
  const finalizeTs = questionState?.finalizeTs || 0;
  const isPendingArbitration = questionState?.isPendingArbitration || false;
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < answerHistory.length; i++) {
    const entry = answerHistory[i];
    if (entry.user.toLowerCase() !== userLower) continue;

    const isLastAnswer = i === answerHistory.length - 1;
    const wasOutbid = i < answerHistory.length - 1;

    let claimable = false;
    let reason = "";

    if (isPendingArbitration) {
      reason = "Pending arbitration — cannot claim yet";
    } else if (wasOutbid) {
      if (isFinalized || (finalizeTs > 0 && now >= finalizeTs)) {
        claimable = true;
        reason = "Outbid — claimable (finalized)";
      } else {
        reason = "Outbid — waiting for finalization";
      }
    } else if (isLastAnswer) {
      if (isFinalized || (finalizeTs > 0 && now >= finalizeTs)) {
        claimable = true;
        reason = "Final answer — claimable";
      } else {
        reason = finalizeTs > 0
          ? `Final answer — finalizes at ${new Date(finalizeTs * 1000).toLocaleString()}`
          : "Final answer — not yet finalizable";
      }
    }

    results.push({
      index: i,
      answer: entry.answer,
      bond: entry.bond,
      ts: entry.ts,
      historyHash: entry.historyHash,
      user: entry.user,
      claimable,
      reason,
      isLastAnswer,
    });
  }

  return results;
}

export function estimateClaimableAmount(claimableAnswers) {
  let total = 0n;
  for (const a of claimableAnswers) {
    if (a.claimable) total += BigInt(a.bond);
  }
  return total;
}

/**
 * Build arrays needed for claimWinnings().
 * Reality.eth expects history in reverse chronological order (newest first).
 */
export function buildClaimArrays(answerHistory) {
  const reversed = [...answerHistory].reverse();

  const historyHashes = reversed.map((a) => a.historyHash);
  const addrs = reversed.map((a) => a.user);
  const bonds = reversed.map((a) => BigInt(a.bond));
  const answers = reversed.map((a) => a.answer);

  return { historyHashes, addrs, bonds, answers };
}

export async function claimWinnings(signer, questionId, answerHistory) {
  const realitio = getRealitioContract(signer);
  const { historyHashes, addrs, bonds, answers } = buildClaimArrays(answerHistory);

  return realitio.claimWinnings(questionId, historyHashes, addrs, bonds, answers);
}

export async function claimMultipleAndWithdraw(signer, claims) {
  const realitio = getRealitioContract(signer);

  const questionIds = [];
  const lengths = [];
  const allHistoryHashes = [];
  const allAddrs = [];
  const allBonds = [];
  const allAnswers = [];

  for (const claim of claims) {
    const { historyHashes, addrs, bonds, answers } = buildClaimArrays(claim.answerHistory);

    questionIds.push(claim.questionId);
    lengths.push(historyHashes.length);
    allHistoryHashes.push(...historyHashes);
    allAddrs.push(...addrs);
    allBonds.push(...bonds);
    allAnswers.push(...answers);
  }

  return realitio.claimMultipleAndWithdrawBalance(
    questionIds,
    lengths,
    allHistoryHashes,
    allAddrs,
    allBonds,
    allAnswers
  );
}

export async function withdrawBalance(signer) {
  const realitio = getRealitioContract(signer);
  return realitio.withdraw();
}

export async function getUnclaimedBalance(provider, address) {
  const realitio = getRealitioContract(provider);
  return realitio.balanceOf(address);
}

export function buildClaimPreview(questionId, answerHistory) {
  const { historyHashes } = buildClaimArrays(answerHistory);
  return {
    contract: "Reality.eth v3.0",
    method: "claimWinnings(bytes32,bytes32[],address[],uint256[],bytes32[])",
    params: {
      question_id: questionId,
      history_hashes_count: historyHashes.length,
    },
  };
}

export async function scanClaimableBonds(provider, userAddress, questionStates) {
  const proposals = await dbGetAll("proposals");
  const claimable = [];

  for (const proposal of proposals) {
    const qs = questionStates.get(proposal.questionId);
    if (!qs) continue;

    const now = Math.floor(Date.now() / 1000);
    const isReady = qs.isFinalized || (qs.finalizeTs > 0 && now >= qs.finalizeTs);
    if (!isReady && !qs.isPendingArbitration) continue;

    try {
      const history = await getFullAnswerHistory(provider, proposal.questionId, proposal.createdBlock || 0);
      if (history.length === 0) continue;

      const userParticipated = history.some((a) => a.user.toLowerCase() === userAddress.toLowerCase());
      if (!userParticipated) continue;

      const userClaims = computeClaimableAnswers(history, qs, userAddress);
      const claimableEntries = userClaims.filter((c) => c.claimable);

      if (claimableEntries.length > 0) {
        const totalClaimable = estimateClaimableAmount(claimableEntries);
        claimable.push({
          questionId: proposal.questionId,
          proposalId: proposal.proposalId,
          claimableAnswers: claimableEntries,
          answerHistory: history,
          totalClaimable,
          questionState: qs,
        });
      }
    } catch (err) {
      console.warn(`Error scanning claims for ${proposal.questionId}:`, err.message);
    }
  }

  return claimable;
}
