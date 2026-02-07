/**
 * ui.js — UI rendering, DOM manipulation, and user interaction handling
 *
 * Implements Section 8 of the SRD: proposals list, proposal detail, settings.
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import { formatAnswer, formatDuration, computeProposalStatus, parseQuestionText } from "./reality.js";

// ---- Toast Notifications ----

export function showToast(message, type = "info", durationMs = 4000) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

// ---- Status helpers ----

export function setStatus(elementId, message, type = "") {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.className = `status-box ${type}`;
  }
}

// ---- Network / Wallet badges ----

export function updateNetworkBadge(chainId, connected) {
  const el = document.getElementById("network-badge");
  if (connected && chainId) {
    const name = chainId === 1 ? "Ethereum" : `Chain ${chainId}`;
    el.textContent = `🟢 ${name}`;
    el.className = "badge badge-success";
  } else {
    el.textContent = "⏳ No RPC";
    el.className = "badge badge-neutral";
  }
}

export function updateSyncBadge(text, type = "neutral") {
  const el = document.getElementById("sync-badge");
  el.textContent = text;
  el.className = `badge badge-${type}`;
}

export function updateWalletButton(address) {
  const btn = document.getElementById("btn-wallet");
  if (address) {
    btn.textContent = `${address.slice(0, 6)}…${address.slice(-4)}`;
    btn.title = address;
  } else {
    btn.textContent = "Connect Wallet";
    btn.title = "";
  }
}

// ---- Settings Panel ----

export function showSettings() {
  document.getElementById("settings-panel").classList.remove("hidden");
}

export function hideSettings() {
  document.getElementById("settings-panel").classList.add("hidden");
}

export function toggleSettings() {
  document.getElementById("settings-panel").classList.toggle("hidden");
}

export function populateSettings(settings) {
  document.getElementById("input-rpc").value = settings.rpcUrl || "";
  document.getElementById("input-rpc-fallback").value = settings.rpcFallback || "";
  document.getElementById("input-backfill").value = settings.backfillDays || 7;
  document.getElementById("input-poll-interval").value = settings.pollIntervalSec || 30;
}

export function readSettingsFromUI() {
  return {
    rpcUrl: document.getElementById("input-rpc").value.trim(),
    rpcFallback: document.getElementById("input-rpc-fallback").value.trim(),
    backfillDays: parseInt(document.getElementById("input-backfill").value, 10) || 7,
    pollIntervalSec: parseInt(document.getElementById("input-poll-interval").value, 10) || 30,
  };
}

export function showModuleConfig(config) {
  document.getElementById("module-config").classList.remove("hidden");
  document.getElementById("cfg-avatar").textContent = config.avatar;
  document.getElementById("cfg-target").textContent = config.target;
  document.getElementById("cfg-oracle").textContent = config.oracle;
  document.getElementById("cfg-cooldown").textContent = formatDuration(config.questionCooldown);
  document.getElementById("cfg-expiration").textContent =
    config.answerExpiration > 0 ? formatDuration(config.answerExpiration) : "None (no expiry)";
  document.getElementById("cfg-minbond").textContent = `${ethers.formatEther(config.minimumBond)} ETH`;
}

// ---- Loading indicator ----

export function showLoading(message = "") {
  document.getElementById("proposals-loading").classList.remove("hidden");
  if (message) document.getElementById("indexing-progress").textContent = message;
}

export function hideLoading() {
  document.getElementById("proposals-loading").classList.add("hidden");
}

export function updateLoadingProgress(message) {
  document.getElementById("indexing-progress").textContent = message;
}

// ---- Proposals Table ----

/**
 * Render the proposals list table.
 *
 * @param {Array} proposals - from IndexedDB
 * @param {Map} questionStates - questionId → state
 * @param {object} moduleConfig
 * @param {Function} onView - callback(proposal)
 */
export function renderProposalsTable(proposals, questionStates, moduleConfig, onView) {
  const tbody = document.getElementById("proposals-tbody");
  const noProposals = document.getElementById("no-proposals");
  tbody.innerHTML = "";

  if (proposals.length === 0) {
    noProposals.classList.remove("hidden");
    return;
  }
  noProposals.classList.add("hidden");

  // Sort newest first
  const sorted = [...proposals].sort((a, b) => (b.createdBlock || 0) - (a.createdBlock || 0));

  for (const p of sorted) {
    const qs = questionStates.get(p.questionId) || null;
    const status = computeProposalStatus(qs, moduleConfig);

    const tr = document.createElement("tr");

    // Proposal ID (truncated)
    const pidDisplay = p.proposalId
      ? (p.proposalId.length > 20 ? p.proposalId.slice(0, 20) + "…" : p.proposalId)
      : "—";
    tr.innerHTML = `
      <td class="mono" title="${escapeHtml(p.proposalId || "")}">${escapeHtml(pidDisplay)}</td>
      <td class="mono" title="${p.questionId}">${p.questionId.slice(0, 10)}…${p.questionId.slice(-6)}</td>
      <td><span class="status-pill status-${status.label}">${status.label}</span></td>
      <td>${qs ? formatAnswer(qs.bestAnswer) : "—"}</td>
      <td>${qs ? ethers.formatEther(qs.bond) : "—"}</td>
      <td>${qs && qs.finalizeTs > 0 ? formatFinalizeEta(qs.finalizeTs, qs.isFinalized) : "—"}</td>
      <td>${status.executable ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-neutral">No</span>'}</td>
      <td><button class="btn btn-secondary btn-view" data-qid="${p.questionId}">View</button></td>
    `;

    const viewBtn = tr.querySelector(".btn-view");
    viewBtn.addEventListener("click", () => onView(p));
    tbody.appendChild(tr);
  }
}

function formatFinalizeEta(finalizeTs, isFinalized) {
  if (isFinalized) return "Finalized ✓";
  const now = Math.floor(Date.now() / 1000);
  if (finalizeTs <= now) return "Ready";
  return formatDuration(finalizeTs - now);
}

// ---- Proposal Detail ----

/**
 * Show the proposal detail panel.
 */
export function showDetail(proposal, questionState, moduleConfig, answers) {
  // Hide proposals list, show detail
  document.getElementById("proposals-panel").classList.add("hidden");
  document.getElementById("detail-panel").classList.remove("hidden");

  const status = computeProposalStatus(questionState, moduleConfig);

  // Identifiers
  document.getElementById("det-proposalId").textContent = proposal.proposalId || "—";
  document.getElementById("det-questionId").textContent = proposal.questionId;
  document.getElementById("det-createdTx").textContent = proposal.createdTxHash || "—";
  document.getElementById("det-createdBlock").textContent = proposal.createdBlock || "—";
  document.getElementById("det-createdTime").textContent = proposal.createdTimestamp
    ? new Date(proposal.createdTimestamp * 1000).toLocaleString()
    : "—";

  // Question Text
  const qtext = proposal.questionText || "";
  const parsed = parseQuestionText(qtext);
  document.getElementById("det-questionText").textContent = parsed.parsed
    ? JSON.stringify(parsed.parsed, null, 2)
    : (qtext || "No question text available");

  // Reality Status
  if (questionState) {
    document.getElementById("det-status").innerHTML =
      `<span class="status-pill status-${status.label}">${status.label}</span> — ${escapeHtml(status.reason)}`;
    document.getElementById("det-bestAnswer").textContent = formatAnswer(questionState.bestAnswer);
    document.getElementById("det-bond").textContent = `${ethers.formatEther(questionState.bond)} ETH`;
    document.getElementById("det-finalizeTs").textContent = questionState.finalizeTs > 0
      ? new Date(questionState.finalizeTs * 1000).toLocaleString()
      : "—";

    const now = Math.floor(Date.now() / 1000);
    document.getElementById("det-timeRemaining").textContent =
      questionState.isFinalized
        ? "Finalized"
        : (questionState.finalizeTs > now ? formatDuration(questionState.finalizeTs - now) : "Ready");
    document.getElementById("det-arbitration").textContent =
      questionState.isPendingArbitration ? "Yes ⚠" : "No";
  } else {
    document.getElementById("det-status").textContent = "Loading...";
    document.getElementById("det-bestAnswer").textContent = "—";
    document.getElementById("det-bond").textContent = "—";
    document.getElementById("det-finalizeTs").textContent = "—";
    document.getElementById("det-timeRemaining").textContent = "—";
    document.getElementById("det-arbitration").textContent = "—";
  }

  // Module Thresholds
  document.getElementById("det-minBond").textContent = `${ethers.formatEther(moduleConfig.minimumBond)} ETH`;
  document.getElementById("det-cooldown").textContent = formatDuration(moduleConfig.questionCooldown);
  document.getElementById("det-expiration").textContent =
    moduleConfig.answerExpiration > 0 ? formatDuration(moduleConfig.answerExpiration) : "None";
  document.getElementById("det-executable").innerHTML = status.executable
    ? '<span class="badge badge-success">Yes — Ready to execute</span>'
    : `<span class="badge badge-neutral">No — ${escapeHtml(status.reason)}</span>`;

  // Tx Hashes
  const txHashList = document.getElementById("det-txHashes");
  txHashList.innerHTML = "";
  if (proposal.txHashes && proposal.txHashes.length > 0) {
    for (let i = 0; i < proposal.txHashes.length; i++) {
      const li = document.createElement("li");
      li.textContent = `[${i}] ${proposal.txHashes[i]}`;
      txHashList.appendChild(li);
    }
  } else {
    txHashList.innerHTML = "<li>No tx hashes recovered</li>";
  }

  // Answer History
  renderAnswerHistory(answers || []);

  // Vote section visibility
  const walletWarning = document.getElementById("vote-wallet-warning");
  const voteForm = document.getElementById("vote-form");
  // These will be toggled by the app based on wallet state

  // Execute section
  const execNotExec = document.getElementById("exec-not-executable");
  if (!status.executable) {
    execNotExec.classList.remove("hidden");
    execNotExec.textContent = `Not executable: ${status.reason}`;
  } else {
    execNotExec.classList.add("hidden");
  }
}

/**
 * Hide detail, show proposals list.
 */
export function hideDetail() {
  document.getElementById("detail-panel").classList.add("hidden");
  document.getElementById("proposals-panel").classList.remove("hidden");
}

/**
 * Render answer history table.
 */
function renderAnswerHistory(answers) {
  const tbody = document.getElementById("answer-history-tbody");
  tbody.innerHTML = "";

  if (answers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No answers recorded</td></tr>';
    return;
  }

  // Sort by timestamp descending
  const sorted = [...answers].sort((a, b) => (b.ts || 0) - (a.ts || 0));

  for (const a of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatAnswer(a.answer)}</td>
      <td class="mono" title="${a.user}">${a.user ? a.user.slice(0, 8) + "…" + a.user.slice(-4) : "—"}</td>
      <td>${ethers.formatEther(a.bond || "0")} ETH</td>
      <td>${a.ts ? new Date(a.ts * 1000).toLocaleString() : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---- Filter / Search ----

export function getSearchFilter() {
  return document.getElementById("search-proposals").value.trim().toLowerCase();
}

export function getStatusFilter() {
  return document.getElementById("filter-status").value;
}

/**
 * Apply search and status filter to proposals list.
 */
export function filterProposals(proposals, questionStates, moduleConfig, searchText, statusFilter) {
  return proposals.filter((p) => {
    // Search filter
    if (searchText) {
      const matchPid = (p.proposalId || "").toLowerCase().includes(searchText);
      const matchQid = (p.questionId || "").toLowerCase().includes(searchText);
      if (!matchPid && !matchQid) return false;
    }

    // Status filter
    if (statusFilter && statusFilter !== "all") {
      const qs = questionStates.get(p.questionId) || null;
      const status = computeProposalStatus(qs, moduleConfig);
      if (status.label !== statusFilter) return false;
    }

    return true;
  });
}

// ---- Utilities ----

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
