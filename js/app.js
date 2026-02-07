/**
 * app.js — Main application entry point
 *
 * Wires together all modules: config, DB, indexer, reality adapter,
 * wallet, vote, execute, and UI rendering.
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import {
  MODULE_ADDRESS,
  REALITIO_ADDRESS,
  loadSettings,
  saveSettings,
} from "./config.js";
import {
  openDB,
  dbGetAll,
  dbClearAll,
  getSetting,
  setSetting,
  exportDB,
  importDB,
} from "./db.js";
import {
  backfillProposals,
  startPolling,
  stopPolling,
  fetchAnswerHistory,
} from "./indexer.js";
import {
  loadQuestionState,
  loadModuleConfig,
  computeSuggestedBond,
  formatAnswer,
} from "./reality.js";
import { connectWallet, disconnectWallet, getSigner, getAddress, isConnected, onAccountsChanged, onChainChanged } from "./wallet.js";
import { submitAnswer, buildAnswerPreview } from "./vote.js";
import {
  importTxBundle,
  saveTxBundle,
  loadTxBundle,
  verifyTxBundle,
  executeProposalTx,
  buildExecutePreview,
} from "./execute.js";
import {
  showToast,
  setStatus,
  updateNetworkBadge,
  updateSyncBadge,
  updateWalletButton,
  toggleSettings,
  populateSettings,
  readSettingsFromUI,
  showModuleConfig,
  showLoading,
  hideLoading,
  updateLoadingProgress,
  renderProposalsTable,
  showDetail,
  hideDetail,
  filterProposals,
  getSearchFilter,
  getStatusFilter,
} from "./ui.js";

// ---- App State ----
let provider = null;
let chainId = null;
let moduleConfig = null;
let allProposals = [];
let questionStates = new Map();
let currentProposal = null; // for detail view
let selectedAnswer = null; // "yes" | "no"

// ---- Initialization ----

async function init() {
  await openDB();

  const settings = loadSettings();
  populateSettings(settings);

  // Bind UI events
  bindEvents();

  // If we have an RPC URL saved, auto-connect
  if (settings.rpcUrl) {
    await connectRPC(settings.rpcUrl, settings.rpcFallback);
  }
}

// ---- RPC Connection ----

async function connectRPC(rpcUrl, fallbackUrl) {
  try {
    setStatus("settings-status", "Connecting to RPC...", "info");

    // Create provider with fallback
    provider = new ethers.JsonRpcProvider(rpcUrl);

    // Validate chain
    const network = await provider.getNetwork();
    chainId = Number(network.chainId);

    // Validate contracts exist
    const [moduleCode, oracleCode] = await Promise.all([
      provider.getCode(MODULE_ADDRESS),
      provider.getCode(REALITIO_ADDRESS),
    ]);

    if (moduleCode === "0x" || moduleCode.length < 4) {
      throw new Error(`No contract found at Module address ${MODULE_ADDRESS} on chain ${chainId}`);
    }
    if (oracleCode === "0x" || oracleCode.length < 4) {
      throw new Error(`No contract found at Reality.eth address ${REALITIO_ADDRESS} on chain ${chainId}`);
    }

    // Load module configuration (FR-2)
    moduleConfig = await loadModuleConfig(provider);

    updateNetworkBadge(chainId, true);
    showModuleConfig(moduleConfig);
    setStatus("settings-status", `Connected to chain ${chainId}`, "success");
    showToast(`Connected to chain ${chainId}`, "success");

    // Load cached proposals
    await loadCachedData();

    // Check if we need to backfill
    const lastBlock = await getSetting("lastProcessedBlock");
    if (!lastBlock) {
      showToast("No cached data. Starting backfill...", "info");
      await runBackfill();
    } else {
      // Just fetch updates since last block
      updateSyncBadge("Syncing...", "warning");
      try {
        const { fetchNewProposals } = await import("./indexer.js");
        const newProposals = await fetchNewProposals(provider);
        if (newProposals.length > 0) {
          showToast(`Found ${newProposals.length} new proposals`, "info");
          await loadCachedData();
        }
      } catch (err) {
        console.error("Update error:", err);
      }
      updateSyncBadge("Synced ✓", "success");
    }

    // Start live polling
    const settings = loadSettings();
    startPolling(provider, settings.pollIntervalSec, async (newProposals) => {
      if (newProposals.length > 0) {
        showToast(`${newProposals.length} new proposal(s) found`, "info");
        await loadCachedData();
        refreshUI();
      }
      updateSyncBadge(`Synced ✓`, "success");
    });

  } catch (err) {
    console.error("RPC connection error:", err);
    setStatus("settings-status", `Error: ${err.message}`, "error");
    showToast(`Connection failed: ${err.message}`, "error");
    updateNetworkBadge(null, false);
  }
}

// ---- Backfill ----

async function runBackfill() {
  if (!provider) {
    showToast("Connect to an RPC first", "warning");
    return;
  }

  const settings = loadSettings();
  showLoading("Starting backfill...");
  updateSyncBadge("Backfilling...", "warning");

  try {
    const proposals = await backfillProposals(
      provider,
      settings.backfillDays,
      (pct, count, msg) => {
        updateLoadingProgress(msg);
      }
    );

    showToast(`Backfill complete: ${proposals.length} proposals found`, "success");

    // Now load question states for all proposals
    updateLoadingProgress("Loading Reality.eth states...");
    await loadAllQuestionStates(proposals);

    await loadCachedData();
    refreshUI();
  } catch (err) {
    console.error("Backfill error:", err);
    showToast(`Backfill failed: ${err.message}`, "error");
  } finally {
    hideLoading();
    updateSyncBadge("Synced ✓", "success");
  }
}

// ---- Data Loading ----

async function loadCachedData() {
  allProposals = await dbGetAll("proposals");
  const states = await dbGetAll("questions_state");
  questionStates = new Map(states.map((s) => [s.questionId, s]));
  refreshUI();
}

async function loadAllQuestionStates(proposals) {
  for (let i = 0; i < proposals.length; i++) {
    try {
      const state = await loadQuestionState(provider, proposals[i].questionId);
      questionStates.set(proposals[i].questionId, state);
    } catch (err) {
      console.warn(`Could not load state for ${proposals[i].questionId}:`, err.message);
    }
  }
}

// ---- UI Refresh ----

function refreshUI() {
  if (!moduleConfig) return;

  const search = getSearchFilter();
  const status = getStatusFilter();
  const filtered = filterProposals(allProposals, questionStates, moduleConfig, search, status);

  renderProposalsTable(filtered, questionStates, moduleConfig, (proposal) => {
    openProposalDetail(proposal);
  });
}

// ---- Proposal Detail ----

async function openProposalDetail(proposal) {
  currentProposal = proposal;

  // Load fresh question state
  let qs = questionStates.get(proposal.questionId);
  if (provider) {
    try {
      qs = await loadQuestionState(provider, proposal.questionId);
      questionStates.set(proposal.questionId, qs);
    } catch (err) {
      console.warn("Could not refresh question state:", err.message);
    }
  }

  // Load answer history
  let answers = [];
  if (provider) {
    try {
      answers = await fetchAnswerHistory(provider, proposal.questionId);
    } catch (err) {
      console.warn("Could not load answer history:", err.message);
    }
  }

  showDetail(proposal, qs, moduleConfig, answers);

  // Update vote section
  updateVoteSection(qs);

  // Update execute section
  updateExecuteSection(proposal, qs);
}

function updateVoteSection(questionState) {
  const walletWarning = document.getElementById("vote-wallet-warning");
  const voteForm = document.getElementById("vote-form");

  if (!isConnected()) {
    walletWarning.classList.remove("hidden");
    voteForm.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  } else {
    walletWarning.classList.add("hidden");
    document.getElementById("btn-vote-yes").disabled = false;
    document.getElementById("btn-vote-no").disabled = false;
  }

  // Bond suggestion
  if (questionState && moduleConfig) {
    const suggested = computeSuggestedBond(questionState.bond, moduleConfig.minimumBond);
    document.getElementById("bond-suggestion").textContent =
      `Suggested: ${ethers.formatEther(suggested)} ETH (≥ 2× current bond and ≥ module minimum)`;
    document.getElementById("input-bond").value = ethers.formatEther(suggested);
    document.getElementById("input-max-previous").value = ethers.formatEther(questionState.bond);
  }

  // Reset selection
  selectedAnswer = null;
  document.getElementById("btn-vote-yes").classList.remove("selected");
  document.getElementById("btn-vote-no").classList.remove("selected");
  document.getElementById("btn-submit-vote").disabled = true;
  document.getElementById("vote-preview").classList.add("hidden");
}

async function updateExecuteSection(proposal, questionState) {
  const walletWarning = document.getElementById("exec-wallet-warning");
  if (!isConnected()) {
    walletWarning.classList.remove("hidden");
  } else {
    walletWarning.classList.add("hidden");
  }

  // Try to load saved tx bundle
  if (proposal.proposalId) {
    const bundle = await loadTxBundle(proposal.proposalId);
    if (bundle) {
      renderTxBundle(bundle, proposal);
    }
  }
}

function renderTxBundle(bundle, proposal) {
  const preview = document.getElementById("tx-bundle-preview");
  const tbody = document.getElementById("tx-bundle-tbody");
  preview.classList.remove("hidden");
  tbody.innerHTML = "";

  // Verify hashes match
  let verified = { valid: false, reason: "No proposal txHashes to verify against" };
  if (proposal.txHashes && proposal.txHashes.length > 0) {
    verified = verifyTxBundle(bundle, proposal.txHashes);
  }

  if (!verified.valid) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--accent-red)">⚠ ${verified.reason}</td></tr>`;
  }

  for (let i = 0; i < bundle.transactions.length; i++) {
    const tx = bundle.transactions[i];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i}</td>
      <td class="mono" title="${tx.to}">${tx.to.slice(0, 10)}…</td>
      <td>${tx.value || "0"} wei</td>
      <td class="mono" title="${tx.data}">${tx.data.length > 20 ? tx.data.slice(0, 20) + "…" : tx.data}</td>
      <td>${tx.operation === 1 ? "DelegateCall" : "Call"}</td>
      <td><button class="btn btn-primary btn-exec" data-index="${i}">Execute #${i}</button></td>
    `;

    const execBtn = tr.querySelector(".btn-exec");
    execBtn.disabled = !isConnected();
    execBtn.addEventListener("click", () => executeTx(proposal, bundle, i));
    tbody.appendChild(tr);
  }
}

// ---- Vote / Answer Submission ----

function selectAnswer(isYes) {
  selectedAnswer = isYes ? "yes" : "no";
  document.getElementById("btn-vote-yes").classList.toggle("selected", isYes);
  document.getElementById("btn-vote-no").classList.toggle("selected", !isYes);
  document.getElementById("btn-submit-vote").disabled = false;

  // Show preview
  const bondWei = ethers.parseEther(document.getElementById("input-bond").value || "0").toString();
  const maxPrevWei = ethers.parseEther(document.getElementById("input-max-previous").value || "0").toString();
  const preview = buildAnswerPreview(
    currentProposal.questionId,
    isYes,
    bondWei,
    maxPrevWei
  );
  document.getElementById("vote-preview").classList.remove("hidden");
  document.getElementById("vote-calldata").textContent = JSON.stringify(preview, null, 2);
}

async function doSubmitVote() {
  if (!currentProposal || !selectedAnswer || !isConnected()) return;

  const bondEth = document.getElementById("input-bond").value;
  const maxPrevEth = document.getElementById("input-max-previous").value;

  if (!bondEth || parseFloat(bondEth) <= 0) {
    setStatus("vote-status", "Bond must be > 0", "error");
    return;
  }

  try {
    const bondWei = ethers.parseEther(bondEth).toString();
    const maxPrevWei = ethers.parseEther(maxPrevEth || "0").toString();
    const isYes = selectedAnswer === "yes";

    setStatus("vote-status", "Submitting transaction...", "info");
    document.getElementById("btn-submit-vote").disabled = true;

    const signer = getSigner();
    const tx = await submitAnswer(signer, currentProposal.questionId, isYes, bondWei, maxPrevWei);

    setStatus("vote-status", `Transaction sent: ${tx.hash}`, "info");
    showToast("Transaction submitted! Waiting for confirmation...", "info");

    const receipt = await tx.wait();
    setStatus("vote-status", `Confirmed in block ${receipt.blockNumber} ✓`, "success");
    showToast("Answer submitted successfully!", "success");

    // Refresh the question state
    if (provider) {
      const qs = await loadQuestionState(provider, currentProposal.questionId);
      questionStates.set(currentProposal.questionId, qs);
      updateVoteSection(qs);
    }
  } catch (err) {
    console.error("Vote error:", err);
    setStatus("vote-status", `Error: ${err.reason || err.message}`, "error");
    showToast(`Vote failed: ${err.reason || err.message}`, "error");
  } finally {
    document.getElementById("btn-submit-vote").disabled = false;
  }
}

// ---- Import Tx Bundle ----

function doImportBundle() {
  if (!currentProposal) return;

  const rawJson = document.getElementById("input-tx-bundle").value.trim();
  if (!rawJson) {
    setStatus("exec-status", "Paste a transaction bundle JSON", "error");
    return;
  }

  try {
    const transactions = JSON.parse(rawJson);
    if (!Array.isArray(transactions) || transactions.length === 0) {
      throw new Error("Bundle must be a non-empty array");
    }

    const bundle = importTxBundle(currentProposal.proposalId, transactions, chainId);
    saveTxBundle(bundle);
    renderTxBundle(bundle, currentProposal);
    setStatus("exec-status", `Imported ${transactions.length} transactions`, "success");
    showToast("Transaction bundle imported successfully", "success");
  } catch (err) {
    setStatus("exec-status", `Import error: ${err.message}`, "error");
    showToast(`Import failed: ${err.message}`, "error");
  }
}

// ---- Execute Tx ----

async function executeTx(proposal, bundle, txIndex) {
  if (!isConnected()) {
    showToast("Connect wallet first", "warning");
    return;
  }

  const tx = bundle.transactions[txIndex];
  const preview = buildExecutePreview(proposal.proposalId, proposal.txHashes, tx, txIndex);

  // Confirm
  const confirmed = confirm(
    `Execute transaction #${txIndex}?\n\n` +
    `To: ${tx.to}\nValue: ${tx.value} wei\nData: ${tx.data.slice(0, 66)}...\nOperation: ${tx.operation}\n\n` +
    `This will call executeProposalWithIndex on the Reality Module.`
  );

  if (!confirmed) return;

  try {
    setStatus("exec-status", `Executing tx #${txIndex}...`, "info");
    const signer = getSigner();
    const result = await executeProposalTx(
      signer,
      proposal.proposalId,
      proposal.txHashes,
      tx,
      txIndex
    );

    setStatus("exec-status", `Tx sent: ${result.hash}`, "info");
    showToast("Execution tx submitted!", "info");

    const receipt = await result.wait();
    setStatus("exec-status", `Tx #${txIndex} executed in block ${receipt.blockNumber} ✓`, "success");
    showToast(`Transaction #${txIndex} executed successfully!`, "success");
  } catch (err) {
    console.error("Execution error:", err);
    setStatus("exec-status", `Error: ${err.reason || err.message}`, "error");
    showToast(`Execution failed: ${err.reason || err.message}`, "error");
  }
}

// ---- Wallet Connection ----

async function doConnectWallet() {
  if (isConnected()) {
    disconnectWallet();
    updateWalletButton(null);
    showToast("Wallet disconnected", "info");
    refreshUI();
    return;
  }

  try {
    const { address, chainId: walletChainId } = await connectWallet();
    updateWalletButton(address);
    showToast(`Connected: ${address.slice(0, 8)}…`, "success");

    // Warn if chain mismatch
    if (chainId && walletChainId !== chainId) {
      showToast(`Warning: Wallet is on chain ${walletChainId}, RPC is on chain ${chainId}`, "warning");
    }
  } catch (err) {
    showToast(`Wallet connection failed: ${err.message}`, "error");
  }
}

// ---- Settings Actions ----

async function doSaveSettings() {
  const settings = readSettingsFromUI();
  if (!settings.rpcUrl) {
    setStatus("settings-status", "Please enter an RPC URL", "error");
    return;
  }
  saveSettings(settings);
  stopPolling();
  await connectRPC(settings.rpcUrl, settings.rpcFallback);
}

async function doReindex() {
  if (!confirm("This will clear all cached data and re-index from scratch. Continue?")) return;
  await dbClearAll();
  allProposals = [];
  questionStates = new Map();
  refreshUI();
  showToast("Cache cleared", "info");
  await runBackfill();
}

async function doExportDB() {
  try {
    const data = await exportDB();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gcc-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Database exported", "success");
  } catch (err) {
    showToast(`Export failed: ${err.message}`, "error");
  }
}

function doImportDBClick() {
  document.getElementById("file-import-db").click();
}

async function doImportDBFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await importDB(data);
    await loadCachedData();
    showToast("Database imported successfully", "success");
  } catch (err) {
    showToast(`Import failed: ${err.message}`, "error");
  }
}

// ---- Event Bindings ----

function bindEvents() {
  // Header
  document.getElementById("btn-wallet").addEventListener("click", doConnectWallet);
  document.getElementById("btn-settings").addEventListener("click", toggleSettings);

  // Settings
  document.getElementById("btn-save-settings").addEventListener("click", doSaveSettings);
  document.getElementById("btn-reindex").addEventListener("click", doReindex);
  document.getElementById("btn-export-db").addEventListener("click", doExportDB);
  document.getElementById("btn-import-db").addEventListener("click", doImportDBClick);
  document.getElementById("file-import-db").addEventListener("change", doImportDBFile);

  // Proposals
  document.getElementById("btn-refresh").addEventListener("click", async () => {
    if (!provider) {
      showToast("Connect to an RPC first", "warning");
      return;
    }
    updateSyncBadge("Syncing...", "warning");
    try {
      const { fetchNewProposals } = await import("./indexer.js");
      const newProposals = await fetchNewProposals(provider);
      if (newProposals.length > 0) {
        showToast(`Found ${newProposals.length} new proposals`, "info");
      }
      // Refresh all question states
      await loadAllQuestionStates(allProposals);
      await loadCachedData();
    } catch (err) {
      showToast(`Refresh error: ${err.message}`, "error");
    }
    updateSyncBadge("Synced ✓", "success");
  });

  document.getElementById("search-proposals").addEventListener("input", refreshUI);
  document.getElementById("filter-status").addEventListener("change", refreshUI);

  // Detail panel
  document.getElementById("btn-back").addEventListener("click", () => {
    hideDetail();
    currentProposal = null;
    refreshUI();
  });

  // Vote
  document.getElementById("btn-vote-yes").addEventListener("click", () => selectAnswer(true));
  document.getElementById("btn-vote-no").addEventListener("click", () => selectAnswer(false));
  document.getElementById("btn-submit-vote").addEventListener("click", doSubmitVote);

  // Bond input changes → update preview
  document.getElementById("input-bond").addEventListener("input", () => {
    if (selectedAnswer !== null) selectAnswer(selectedAnswer === "yes");
  });
  document.getElementById("input-max-previous").addEventListener("input", () => {
    if (selectedAnswer !== null) selectAnswer(selectedAnswer === "yes");
  });

  // Execute
  document.getElementById("btn-import-bundle").addEventListener("click", doImportBundle);

  // Wallet events
  onAccountsChanged(async (accounts) => {
    if (accounts.length === 0) {
      disconnectWallet();
      updateWalletButton(null);
    } else {
      try {
        const { address } = await connectWallet();
        updateWalletButton(address);
      } catch { /* */ }
    }
  });

  onChainChanged(() => {
    window.location.reload();
  });
}

// ---- Boot ----
init().catch((err) => {
  console.error("Initialization error:", err);
  showToast(`Init error: ${err.message}`, "error");
});
