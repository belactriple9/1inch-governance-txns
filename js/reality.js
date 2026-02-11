/**
 * reality.js — Reality.eth state adapter
 *
 * Reads question state from the Reality.eth oracle contract,
 * computes proposal status (FR-5, FR-6), and parses question text.
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import { getRealitioContract, getModuleContract } from "./contracts.js";
import { ANSWER_YES, ANSWER_NO, ANSWER_INVALID } from "./config.js";
import { dbPut } from "./db.js";

/**
 * Load the full Reality.eth question state for a given questionId.
 */
export async function loadQuestionState(provider, questionId) {
  const realitio = getRealitioContract(provider);

  const q = await realitio.questions(questionId);
  const finalized = await realitio.isFinalized(questionId);

  let finalAnswer = null;
  if (finalized) {
    try {
      finalAnswer = await realitio.getFinalAnswer(questionId);
    } catch { /* may revert if not finalized or 0 bond */ }
  }

  const state = {
    questionId,
    contentHash: q.content_hash || q[0],
    arbitrator: q.arbitrator || q[1],
    openingTs: Number(q.opening_ts || q[2]),
    timeout: Number(q.timeout || q[3]),
    finalizeTs: Number(q.finalize_ts || q[4]),
    isPendingArbitration: q.is_pending_arbitration || q[5] || false,
    bounty: (q.bounty || q[6])?.toString() || "0",
    bestAnswer: q.best_answer || q[7],
    historyHash: q.history_hash || q[8],
    bond: (q.bond || q[9])?.toString() || "0",
    minBond: (q.min_bond || q[10])?.toString() || "0",
    isFinalized: finalized,
    finalAnswer: finalAnswer,
  };

  // Persist to IndexedDB
  await dbPut("questions_state", state);

  return state;
}

/**
 * Load the Reality Module's configuration parameters (FR-2).
 */
export async function loadModuleConfig(provider) {
  const mod = getModuleContract(provider);

  // Note: ethers v6 Contract has a built-in `.target` property (the address),
  // which shadows the ABI's `target()` function. Use getFunction() to call it.
  const [avatar, target, oracle, cooldown, expiration, minBond] = await Promise.all([
    mod.avatar(),
    mod.getFunction("target")(),
    mod.oracle(),
    mod.questionCooldown(),
    mod.answerExpiration(),
    mod.minimumBond(),
  ]);

  return {
    avatar,
    target,
    oracle,
    questionCooldown: Number(cooldown),
    answerExpiration: Number(expiration),
    minimumBond: minBond.toString(),
  };
}

/**
 * Compute the display status for a proposal (FR-6).
 */
export function computeProposalStatus(questionState, moduleConfig) {
  if (!questionState) {
    return { label: "unknown", executable: false, reason: "No question state" };
  }

  const now = Math.floor(Date.now() / 1000);
  const {
    bestAnswer,
    bond,
    finalizeTs,
    isFinalized,
    finalAnswer,
    isPendingArbitration,
  } = questionState;

  const { questionCooldown, answerExpiration, minimumBond } = moduleConfig;

  // Is the question answered at all?
  const zeroHash = ethers.ZeroHash;
  const hasAnswer = bond !== "0" && bestAnswer !== zeroHash;

  // Pending arbitration?
  if (isPendingArbitration) {
    return { label: "arbitration", executable: false, reason: "Pending arbitration" };
  }

  // Not finalized yet: always keep status pending, even if there is a best answer.
  if (!isFinalized) {
    if (!hasAnswer) {
      return { label: "pending", executable: false, reason: "No answers yet" };
    }
    if (finalizeTs > 0 && now < finalizeTs) {
      return {
        label: "pending",
        executable: false,
        reason: `Best answer set, finalizes in ${formatDuration(finalizeTs - now)}`,
      };
    }
    // finalize_ts passed but isFinalized returned false — it's finalizable but not finalized yet
    return {
      label: "pending",
      executable: false,
      reason: "Best answer set, awaiting finalization call",
    };
  }

  // Finalized — check if executable
  const answer = finalAnswer || bestAnswer;
  const isYes = answer === ANSWER_YES ||
    answer === "0x0000000000000000000000000000000000000000000000000000000000000001";

  if (!isYes) {
    return { label: "finalized", executable: false, reason: "Final answer is NO" };
  }

  // Check minimum bond
  const bondBN = BigInt(bond);
  const minBondBN = BigInt(minimumBond);
  if (bondBN < minBondBN) {
    return {
      label: "finalized",
      executable: false,
      reason: `Bond ${ethers.formatEther(bond)} < min ${ethers.formatEther(minimumBond)}`,
    };
  }

  // Check cooldown
  if (questionCooldown > 0) {
    const cooldownEnd = finalizeTs + questionCooldown;
    if (now < cooldownEnd) {
      return {
        label: "finalized",
        executable: false,
        reason: `Cooldown: ${formatDuration(cooldownEnd - now)} remaining`,
      };
    }
  }

  // Check answer expiration
  if (answerExpiration > 0) {
    const expiresAt = finalizeTs + answerExpiration;
    if (now > expiresAt) {
      return {
        label: "finalized",
        executable: false,
        reason: "Answer has expired",
      };
    }
  }

  return { label: "executable", executable: true, reason: "Ready to execute" };
}

/**
 * Parse a Reality.eth question text.
 * Can be JSON (template-expanded) or ␟-delimited.
 */
export function parseQuestionText(text) {
  if (!text) return { raw: "", parsed: null };

  const trimmed = text.trim();

  // Try JSON first
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { raw: text, parsed: JSON.parse(trimmed) };
    } catch { /* fall through */ }
  }

  // Try ␟ (unit separator) delimited
  if (trimmed.includes("\u241f") || trimmed.includes("\u001f")) {
    const sep = trimmed.includes("\u241f") ? "\u241f" : "\u001f";
    const parts = trimmed.split(sep);
    return { raw: text, parsed: parts };
  }

  return { raw: text, parsed: null };
}

/**
 * Format a boolean answer (bytes32) for display.
 */
export function formatAnswer(answer) {
  if (!answer || answer === ethers.ZeroHash) return "NO (0x0)";
  if (answer === ANSWER_YES || answer === "0x0000000000000000000000000000000000000000000000000000000000000001") {
    return "YES ✓";
  }
  if (answer === ANSWER_NO || answer === ethers.ZeroHash) {
    return "NO ✗";
  }
  if (answer === ANSWER_INVALID) {
    return "INVALID ⚠";
  }
  return `Unknown (${answer.slice(0, 10)}...)`;
}

/**
 * Format seconds as human-readable duration.
 */
export function formatDuration(seconds) {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 && d === 0) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

/**
 * Compute the suggested bond for a new answer.
 * Reality requires >= 2x previous bond, and module requires >= minimumBond.
 */
export function computeSuggestedBond(currentBondWei, minimumBondWei) {
  const current = BigInt(currentBondWei || "0");
  const minBond = BigInt(minimumBondWei || "0");
  const doubleBond = current * 2n;
  const suggested = doubleBond > minBond ? doubleBond : minBond;
  // If no bond yet, use minimum bond (or a small default)
  if (suggested === 0n) {
    return minBond > 0n ? minBond : ethers.parseEther("0.01");
  }
  return suggested;
}
