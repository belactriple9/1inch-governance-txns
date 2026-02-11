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
  SECONDS_PER_DAY,
  loadSettings,
  saveSettings,
} from "./config.js";
import {
  openDB,
  dbGetAll,
  dbGetAllByIndex,
  dbClearAll,
  getSetting,
  setSetting,
  exportDB,
  importDB,
} from "./db.js";
import {
  backfillProposals,
  backfillProposalsRange,
  backfillAnswerHistory,
  estimateBlockFromTime,
  fetchNewProposals,
  fetchAnswerHistory,
  findProposalById,
  startPolling,
  stopPolling,
  setRpcFailureHandler,
} from "./indexer.js";
import {
  loadQuestionState,
  loadModuleConfig,
  computeSuggestedBond,
} from "./reality.js";
import {
  connectWallet,
  disconnectWallet,
  getSigner,
  getAddress,
  isConnected,
  onAccountsChanged,
  onChainChanged,
} from "./wallet.js";
import {
  submitAnswer,
  buildAnswerPreview,
  notifyArbitrationRequest,
  buildArbitrationPreview,
} from "./vote.js";
import {
  importTxBundle,
  saveTxBundle,
  loadTxBundle,
  verifyTxBundle,
  executeProposalTx,
} from "./execute.js";
import {
  getFullAnswerHistory,
  computeClaimableAnswers,
  estimateClaimableAmount,
  claimWinnings,
  claimMultipleAndWithdraw,
  withdrawBalance,
  getUnclaimedBalance,
  scanClaimableBonds,
  buildClaimPreview,
} from "./claim.js";
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
  renderClaimSection,
  renderClaimsOverview,
} from "./ui.js";

// ---- App State ----
let provider = null;
let chainId = null;
let moduleConfig = null;
let allProposals = [];
let questionStates = new Map();
let currentProposal = null;
let selectedAnswer = null; // "yes" | "no"
let currentRpcUrl = "";
let currentFallbackUrl = "";
let rpcFailoverInProgress = false;
let pendingDeepLinkProposalId = null;

// ---- Initialization ----

async function init() {
  await openDB();

  const settings = loadSettings();
  populateSettings(settings);
  pendingDeepLinkProposalId = getProposalIdFromLocation();

  bindEvents();

  if (settings.rpcUrl) {
    await connectRPC(settings.rpcUrl, settings.rpcFallback);
  }
}

// ---- Routing / Deep Link ----

function normalizeProposalId(id) {
  return (id || "").trim().toLowerCase();
}

function getProposalIdFromLocation() {
  const marker = "/governance-tx/";
  const path = window.location.pathname;
  const idx = path.toLowerCase().indexOf(marker);
  if (idx >= 0) {
    const raw = path.slice(idx + marker.length).split("/")[0];
    if (raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("proposalId") || params.get("proposal");
  if (fromQuery) return fromQuery;

  const hashMatch = (window.location.hash || "").match(/^#\/?governance-tx\/([^/?]+)/i);
  if (hashMatch?.[1]) {
    try {
      return decodeURIComponent(hashMatch[1]);
    } catch {
      return hashMatch[1];
    }
  }

  return null;
}

function getBasePath() {
  const marker = "/governance-tx/";
  const path = window.location.pathname;

  if (path.includes(marker)) {
    return path.slice(0, path.indexOf(marker));
  }

  if (path.endsWith(".html")) {
    const slashIdx = path.lastIndexOf("/");
    return slashIdx >= 0 ? path.slice(0, slashIdx) : "";
  }

  if (path === "/") return "";
  return path.replace(/\/$/, "");
}

function getRootRoute() {
  const base = getBasePath();
  return base ? `${base}/` : "/";
}

function setProposalRoute(proposalId) {
  if (!proposalId) return;

  const base = getBasePath();
  const nextPath = `${base}/governance-tx/${encodeURIComponent(proposalId)}`.replace(/\/{2,}/g, "/");
  window.history.replaceState({ proposalId }, "", nextPath);
}

function clearProposalRoute() {
  window.history.replaceState({}, "", getRootRoute());
}

function findLocalProposalById(proposalId) {
  const target = normalizeProposalId(proposalId);
  if (!target) return null;
  return allProposals.find((p) => normalizeProposalId(p.proposalId) === target) || null;
}

async function resolvePendingDeepLink() {
  if (!pendingDeepLinkProposalId || !provider) return;

  const targetId = pendingDeepLinkProposalId;
  let proposal = findLocalProposalById(targetId);

  if (!proposal) {
    showLoading(`Searching chain for proposal ${targetId}...`);
    updateSyncBadge("Searching proposal...", "warning");

    try {
      proposal = await findProposalById(provider, targetId, (pct, _count, msg) => {
        updateLoadingProgress(msg || `Searching... ${pct}%`);
      });

      if (proposal) {
        await loadAllQuestionStates([proposal]);
        await loadCachedData();
      }
    } catch (err) {
      console.error("Deep-link search error:", err);
      showToast(`Proposal lookup failed: ${err.message}`, "error");
    } finally {
      hideLoading();
    }
  }

  if (proposal) {
    pendingDeepLinkProposalId = null;
    await openProposalDetail(proposal, { updateRoute: false });
    showToast(`Opened proposal ${proposal.proposalId || proposal.questionId}`, "success");
  } else {
    showToast(`Proposal not found on-chain: ${targetId}`, "warning");
  }

  updateSyncBadge("Synced ✓", "success");
}

// ---- RPC Connection ----

async function connectRPC(rpcUrl, fallbackUrl) {
  try {
    currentRpcUrl = (rpcUrl || "").trim();
    currentFallbackUrl = (fallbackUrl || "").trim();

    if (!currentRpcUrl) {
      throw new Error("RPC URL is empty");
    }

    setStatus("settings-status", "Connecting to RPC...", "info");
    updateSyncBadge("Connecting...", "warning");

    stopPolling();

    provider = new ethers.JsonRpcProvider(currentRpcUrl);
    setRpcFailureHandler(handleRpcFailure);

    const network = await provider.getNetwork();
    chainId = Number(network.chainId);

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

    moduleConfig = await loadModuleConfig(provider);

    updateNetworkBadge(chainId, true);
    showModuleConfig(moduleConfig);
    setStatus("settings-status", `Connected to chain ${chainId}`, "success");
    showToast(`Connected to chain ${chainId}`, "success");

    await loadCachedData();

    const lastBlock = Number((await getSetting("lastProcessedBlock")) || 0);
    if (!lastBlock) {
      showToast("No cached data. Starting backfill...", "info");
      await runBackfill();
    } else {
      updateSyncBadge("Syncing...", "warning");
      await maybeExpandBackfillCoverage();
      await ensureAnswerCacheCoverage();

      const { newProposals, stateUpdates } = await runIncrementalSync();
      if (newProposals.length > 0) {
        showToast(`Found ${newProposals.length} new proposal(s)`, "info");
      }
      if (stateUpdates > 0) {
        showToast(`Updated ${stateUpdates} active proposal state(s)`, "info", 2500);
      }
      updateSyncBadge("Synced ✓", "success");
    }

    await resolvePendingDeepLink();

    const settings = loadSettings();
    startPolling(provider, settings.pollIntervalSec, async (newProposals) => {
      updateSyncBadge("Syncing...", "warning");

      try {
        if (newProposals.length > 0) {
          await loadAllQuestionStates(newProposals);
        }

        const stateUpdates = await refreshActiveQuestionStates();
        if (newProposals.length > 0 || stateUpdates > 0) {
          await loadCachedData();

          if (newProposals.length > 0) {
            showToast(`${newProposals.length} new proposal(s) found`, "info");
          }
        } else {
          refreshUI();
        }

        if (currentProposal) {
          const refreshed = allProposals.find((p) => p.questionId === currentProposal.questionId);
          if (refreshed) {
            await openProposalDetail(refreshed, { updateRoute: false });
          }
        }
      } catch (err) {
        console.error("Polling refresh error:", err);
      }

      updateSyncBadge("Synced ✓", "success");
    });

    return true;
  } catch (err) {
    console.error("RPC connection error:", err);
    setStatus("settings-status", `Error: ${err.message}`, "error");
    showToast(`Connection failed: ${err.message}`, "error");
    updateNetworkBadge(null, false);
    updateSyncBadge("RPC error", "danger");
    provider = null;
    chainId = null;
    moduleConfig = null;
    return false;
  }
}

async function handleRpcFailure(err) {
  if (rpcFailoverInProgress) return;
  rpcFailoverInProgress = true;

  try {
    const settings = loadSettings();
    const configuredFallback = (settings.rpcFallback || currentFallbackUrl || "").trim();

    let nextRpc = "";

    if (configuredFallback && configuredFallback !== currentRpcUrl) {
      const switchConfigured = window.confirm(
        "RPC requests failed repeatedly after exponential backoff (max 32s).\n\n" +
        `Switch to configured backup RPC?\n${configuredFallback}`
      );
      if (switchConfigured) {
        nextRpc = configuredFallback;
      }
    }

    if (!nextRpc) {
      const entered = window.prompt(
        "RPC requests failed repeatedly after exponential backoff (max 32s). Enter a backup RPC URL:"
      );
      if (entered && entered.trim()) {
        nextRpc = entered.trim();
      }
    }

    if (!nextRpc || nextRpc === currentRpcUrl) {
      return;
    }

    const previousRpc = currentRpcUrl;
    const nextSettings = {
      ...settings,
      rpcUrl: nextRpc,
      rpcFallback: previousRpc || settings.rpcFallback || "",
    };

    saveSettings(nextSettings);
    populateSettings(nextSettings);

    showToast(`Switching to backup RPC: ${nextRpc}`, "warning");
    stopPolling();
    await connectRPC(nextRpc, nextSettings.rpcFallback);
  } finally {
    rpcFailoverInProgress = false;
  }
}

// ---- Backfill & Sync ----

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
      (_pct, _count, msg) => {
        updateLoadingProgress(msg);
      }
    );

    showToast(`Backfill complete: ${proposals.length} proposals indexed`, "success");

    updateLoadingProgress("Loading Reality.eth states...");
    await loadAllQuestionStates(proposals);
    await setSetting("answerCacheReady", true);

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

async function maybeExpandBackfillCoverage() {
  if (!provider) return [];

  const settings = loadSettings();
  const desiredStart = await estimateBlockFromTime(provider, settings.backfillDays * SECONDS_PER_DAY);

  let earliestIndexed = await getSetting("earliestIndexedBlock");
  if (earliestIndexed === null || earliestIndexed === undefined) {
    if (allProposals.length > 0) {
      const minBlock = allProposals.reduce(
        (min, p) => Math.min(min, Number(p.createdBlock || Number.MAX_SAFE_INTEGER)),
        Number.MAX_SAFE_INTEGER
      );
      if (Number.isFinite(minBlock) && minBlock !== Number.MAX_SAFE_INTEGER) {
        earliestIndexed = minBlock;
        await setSetting("earliestIndexedBlock", minBlock);
      }
    }
  }

  const earliest = Number(earliestIndexed);
  if (!Number.isFinite(earliest) || desiredStart >= earliest) {
    return [];
  }

  const toBlock = earliest - 1;
  if (toBlock < desiredStart) return [];

  showLoading("Expanding backfill coverage...");
  updateSyncBadge("Backfilling older history...", "warning");

  try {
    const olderProposals = await backfillProposalsRange(
      provider,
      desiredStart,
      toBlock,
      (_pct, _count, msg) => {
        updateLoadingProgress(msg || "Backfilling older proposal range...");
      }
    );

    if (olderProposals.length > 0) {
      updateLoadingProgress("Loading states for newly discovered older proposals...");
      await loadAllQuestionStates(olderProposals);
      await loadCachedData();
      showToast(`Expanded backfill: ${olderProposals.length} older proposal(s) added`, "success");
    }

    return olderProposals;
  } finally {
    hideLoading();
  }
}

async function ensureAnswerCacheCoverage() {
  if (!provider) return;

  const answerCacheReady = await getSetting("answerCacheReady");
  if (answerCacheReady === true) return;

  const lastBlock = Number((await getSetting("lastProcessedBlock")) || 0);
  if (!lastBlock || allProposals.length === 0) {
    await setSetting("answerCacheReady", true);
    return;
  }

  let earliestIndexed = await getSetting("earliestIndexedBlock");
  if (earliestIndexed === null || earliestIndexed === undefined) {
    const minBlock = allProposals.reduce(
      (min, p) => Math.min(min, Number(p.createdBlock || Number.MAX_SAFE_INTEGER)),
      Number.MAX_SAFE_INTEGER
    );
    if (Number.isFinite(minBlock) && minBlock !== Number.MAX_SAFE_INTEGER) {
      earliestIndexed = minBlock;
      await setSetting("earliestIndexedBlock", minBlock);
    }
  }

  const fromBlock = Number(earliestIndexed);
  if (!Number.isFinite(fromBlock) || fromBlock > lastBlock) {
    return;
  }

  showLoading("Indexing historical answer events...");
  updateSyncBadge("Indexing answers...", "warning");

  try {
    const answersIndexed = await backfillAnswerHistory(
      provider,
      fromBlock,
      lastBlock,
      (pct, _count, msg) => {
        updateLoadingProgress(msg || `Indexing answer logs... ${pct}%`);
      }
    );

    await setSetting("answerCacheReady", true);
    if (answersIndexed > 0) {
      showToast(`Indexed ${answersIndexed} historical answer event(s)`, "success");
    }
  } finally {
    hideLoading();
  }
}

async function runIncrementalSync() {
  if (!provider) return { newProposals: [], stateUpdates: 0 };

  const newProposals = await fetchNewProposals(provider);
  if (newProposals.length > 0) {
    await loadAllQuestionStates(newProposals);
  }

  const stateUpdates = await refreshActiveQuestionStates();

  if (newProposals.length > 0 || stateUpdates > 0) {
    await loadCachedData();
  } else {
    refreshUI();
  }

  return { newProposals, stateUpdates };
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

function hasQuestionStateChanged(prev, next) {
  if (!prev || !next) return true;

  return (
    prev.bestAnswer !== next.bestAnswer ||
    prev.bond !== next.bond ||
    prev.finalizeTs !== next.finalizeTs ||
    prev.isFinalized !== next.isFinalized ||
    prev.finalAnswer !== next.finalAnswer ||
    prev.isPendingArbitration !== next.isPendingArbitration ||
    prev.historyHash !== next.historyHash ||
    prev.minBond !== next.minBond
  );
}

async function refreshActiveQuestionStates() {
  if (!provider || allProposals.length === 0) return 0;

  const active = allProposals.filter((proposal) => {
    const qs = questionStates.get(proposal.questionId);
    return !qs || !qs.isFinalized || qs.isPendingArbitration;
  });

  let updates = 0;
  for (let i = 0; i < active.length; i++) {
    const proposal = active[i];
    try {
      const next = await loadQuestionState(provider, proposal.questionId);
      const prev = questionStates.get(proposal.questionId);
      if (hasQuestionStateChanged(prev, next)) {
        updates += 1;
      }
      questionStates.set(proposal.questionId, next);
    } catch (err) {
      console.warn(`Could not refresh state for ${proposal.questionId}:`, err.message);
    }
  }

  return updates;
}

async function getCachedAnswers(questionId) {
  const answers = await dbGetAllByIndex("answers", "questionId", questionId);
  return answers.sort((a, b) => {
    if ((a.blockNumber || 0) !== (b.blockNumber || 0)) {
      return (a.blockNumber || 0) - (b.blockNumber || 0);
    }
    return (a.logIndex || 0) - (b.logIndex || 0);
  });
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

async function openProposalDetail(proposal, options = {}) {
  const { updateRoute = true } = options;
  currentProposal = proposal;

  let qs = questionStates.get(proposal.questionId) || null;
  if (!qs && provider) {
    try {
      qs = await loadQuestionState(provider, proposal.questionId);
      questionStates.set(proposal.questionId, qs);
    } catch (err) {
      console.warn("Could not load missing question state:", err.message);
    }
  }

  let answers = await getCachedAnswers(proposal.questionId);
  if (answers.length === 0 && provider) {
    try {
      await fetchAnswerHistory(provider, proposal.questionId);
      answers = await getCachedAnswers(proposal.questionId);
    } catch (err) {
      console.warn("Could not fetch missing answer history:", err.message);
    }
  }

  showDetail(proposal, qs, moduleConfig, answers);
  if (updateRoute) setProposalRoute(proposal.proposalId);

  updateVoteSection(qs);
  await updateExecuteSection(proposal);
  updateArbitrationSection(qs);
  await updateClaimSection(proposal, qs);
}

function updateVoteSection(questionState) {
  const walletWarning = document.getElementById("vote-wallet-warning");
  const voteForm = document.getElementById("vote-form");

  if (!isConnected()) {
    walletWarning.classList.remove("hidden");
    voteForm.querySelectorAll("button, input").forEach((el) => {
      el.disabled = true;
    });
  } else {
    walletWarning.classList.add("hidden");
    document.getElementById("btn-vote-yes").disabled = false;
    document.getElementById("btn-vote-no").disabled = false;
  }

  if (questionState && moduleConfig) {
    const suggested = computeSuggestedBond(questionState.bond, moduleConfig.minimumBond);
    document.getElementById("bond-suggestion").textContent =
      `Suggested: ${ethers.formatEther(suggested)} ETH (>= 2x current bond and >= module minimum)`;
    document.getElementById("input-bond").value = ethers.formatEther(suggested);
    document.getElementById("input-max-previous").value = ethers.formatEther(questionState.bond);
  }

  selectedAnswer = null;
  document.getElementById("btn-vote-yes").classList.remove("selected");
  document.getElementById("btn-vote-no").classList.remove("selected");
  document.getElementById("btn-submit-vote").disabled = true;
  document.getElementById("vote-preview").classList.add("hidden");
}

function updateArbitrationSection(questionState) {
  const walletWarning = document.getElementById("arb-wallet-warning");
  const maxPrevInput = document.getElementById("input-arb-max-previous");
  const feeInput = document.getElementById("input-arb-fee");
  const btn = document.getElementById("btn-init-arbitration");

  if (!maxPrevInput || !feeInput || !btn || !walletWarning) return;

  if (questionState) {
    maxPrevInput.value = ethers.formatEther(questionState.bond || "0");
    if (questionState.isPendingArbitration) {
      btn.disabled = true;
      setStatus("arb-status", "Arbitration already pending for this question", "info");
      return;
    }
  }

  if (!isConnected()) {
    walletWarning.classList.remove("hidden");
    maxPrevInput.disabled = true;
    feeInput.disabled = true;
    btn.disabled = true;
  } else {
    walletWarning.classList.add("hidden");
    maxPrevInput.disabled = false;
    feeInput.disabled = false;
    btn.disabled = false;
  }
}

async function updateExecuteSection(proposal) {
  const walletWarning = document.getElementById("exec-wallet-warning");
  if (!isConnected()) {
    walletWarning.classList.remove("hidden");
  } else {
    walletWarning.classList.add("hidden");
  }

  if (proposal.proposalId) {
    const bundle = await loadTxBundle(proposal.proposalId);
    if (bundle) {
      renderTxBundle(bundle, proposal);
    }
  }
}

// ---- Bond Claiming ----

async function updateClaimSection(proposal, questionState) {
  if (!proposal) return;

  if (!isConnected() || !provider) {
    renderClaimSection([], proposal.questionId, 0n, null);
    document.getElementById("claim-wallet-warning").classList.remove("hidden");
    return;
  }
  document.getElementById("claim-wallet-warning").classList.add("hidden");

  try {
    const userAddr = getAddress();
    const history = await getFullAnswerHistory(provider, proposal.questionId, proposal.createdBlock || 0);
    const claimable = computeClaimableAnswers(history, questionState, userAddr);
    const totalClaimable = estimateClaimableAmount(claimable);

    let unclaimedBalance = 0n;
    try {
      unclaimedBalance = await getUnclaimedBalance(provider, userAddr);
    } catch {
      // ignore balance failures
    }

    renderClaimSection(claimable, proposal.questionId, totalClaimable, unclaimedBalance);
  } catch (err) {
    console.warn("Error loading claim data:", err.message);
    renderClaimSection([], proposal.questionId, 0n, null);
  }
}

async function doClaimWinnings() {
  if (!currentProposal || !isConnected() || !provider) return;

  try {
    setStatus("claim-status", "Fetching answer history...", "info");

    const history = await getFullAnswerHistory(
      provider,
      currentProposal.questionId,
      currentProposal.createdBlock || 0
    );

    if (history.length === 0) {
      setStatus("claim-status", "No answer history found", "error");
      return;
    }

    buildClaimPreview(currentProposal.questionId, history);

    const signer = getSigner();
    const tx = await claimWinnings(signer, currentProposal.questionId, history);

    setStatus("claim-status", `Transaction sent: ${tx.hash}`, "info");
    showToast("Claim transaction submitted", "info");

    const receipt = await tx.wait();
    setStatus("claim-status", `Claimed in block ${receipt.blockNumber} ✓`, "success");
    showToast("Bond claimed successfully", "success");

    const qs = questionStates.get(currentProposal.questionId);
    await updateClaimSection(currentProposal, qs);
  } catch (err) {
    console.error("Claim error:", err);
    setStatus("claim-status", `Error: ${err.reason || err.message}`, "error");
    showToast(`Claim failed: ${err.reason || err.message}`, "error");
  }
}

async function doWithdrawBalance() {
  if (!isConnected()) return;

  try {
    setStatus("claim-status", "Withdrawing balance...", "info");
    const signer = getSigner();
    const tx = await withdrawBalance(signer);

    setStatus("claim-status", `Transaction sent: ${tx.hash}`, "info");
    showToast("Withdraw transaction submitted", "info");

    const receipt = await tx.wait();
    setStatus("claim-status", `Withdrawn in block ${receipt.blockNumber} ✓`, "success");
    showToast("Balance withdrawn successfully", "success");

    if (currentProposal) {
      const qs = questionStates.get(currentProposal.questionId);
      await updateClaimSection(currentProposal, qs);
    }
  } catch (err) {
    console.error("Withdraw error:", err);
    setStatus("claim-status", `Error: ${err.reason || err.message}`, "error");
    showToast(`Withdraw failed: ${err.reason || err.message}`, "error");
  }
}

async function doScanAllClaims() {
  if (!isConnected() || !provider) {
    showToast("Connect wallet and RPC first", "warning");
    return;
  }

  try {
    showToast("Scanning for claimable bonds...", "info");
    const userAddr = getAddress();
    const claims = await scanClaimableBonds(provider, userAddr, questionStates);

    renderClaimsOverview(
      claims,
      async (claim) => {
        try {
          setStatus("claims-overview-status", `Claiming for ${claim.questionId.slice(0, 10)}...`, "info");
          const signer = getSigner();
          const tx = await claimWinnings(signer, claim.questionId, claim.answerHistory);
          setStatus("claims-overview-status", `Tx sent: ${tx.hash}`, "info");
          const receipt = await tx.wait();
          setStatus("claims-overview-status", `Claimed in block ${receipt.blockNumber} ✓`, "success");
          showToast("Bond claimed", "success");
          await doScanAllClaims();
        } catch (err) {
          setStatus("claims-overview-status", `Error: ${err.reason || err.message}`, "error");
          showToast(`Claim failed: ${err.reason || err.message}`, "error");
        }
      },
      async (allClaims) => {
        try {
          setStatus("claims-overview-status", `Claiming ${allClaims.length} questions...`, "info");
          const signer = getSigner();
          const tx = await claimMultipleAndWithdraw(
            signer,
            allClaims.map((c) => ({ questionId: c.questionId, answerHistory: c.answerHistory }))
          );
          setStatus("claims-overview-status", `Tx sent: ${tx.hash}`, "info");
          const receipt = await tx.wait();
          setStatus("claims-overview-status", `All claimed in block ${receipt.blockNumber} ✓`, "success");
          showToast("All bonds claimed and withdrawn", "success");
          await doScanAllClaims();
        } catch (err) {
          setStatus("claims-overview-status", `Error: ${err.reason || err.message}`, "error");
          showToast(`Batch claim failed: ${err.reason || err.message}`, "error");
        }
      }
    );

    if (claims.length === 0) {
      showToast("No claimable bonds found", "info");
    } else {
      showToast(`Found ${claims.length} question(s) with claimable bonds`, "success");
    }
  } catch (err) {
    console.error("Scan claims error:", err);
    showToast(`Scan failed: ${err.message}`, "error");
  }
}

// ---- Vote / Arbitration ----

function selectAnswer(isYes) {
  selectedAnswer = isYes ? "yes" : "no";
  document.getElementById("btn-vote-yes").classList.toggle("selected", isYes);
  document.getElementById("btn-vote-no").classList.toggle("selected", !isYes);
  document.getElementById("btn-submit-vote").disabled = false;

  const bondWei = ethers.parseEther(document.getElementById("input-bond").value || "0").toString();
  const maxPrevWei = ethers.parseEther(document.getElementById("input-max-previous").value || "0").toString();
  const preview = buildAnswerPreview(currentProposal.questionId, isYes, bondWei, maxPrevWei);

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
    showToast("Vote transaction submitted", "info");

    const receipt = await tx.wait();
    setStatus("vote-status", `Confirmed in block ${receipt.blockNumber} ✓`, "success");
    showToast("Answer submitted successfully", "success");

    if (provider) {
      const qs = await loadQuestionState(provider, currentProposal.questionId);
      questionStates.set(currentProposal.questionId, qs);
      await fetchAnswerHistory(provider, currentProposal.questionId);
      await loadCachedData();
      const refreshed = allProposals.find((p) => p.questionId === currentProposal.questionId) || currentProposal;
      await openProposalDetail(refreshed, { updateRoute: false });
    }
  } catch (err) {
    console.error("Vote error:", err);
    setStatus("vote-status", `Error: ${err.reason || err.message}`, "error");
    showToast(`Vote failed: ${err.reason || err.message}`, "error");
  } finally {
    document.getElementById("btn-submit-vote").disabled = false;
  }
}

async function doInitiateArbitration() {
  if (!currentProposal || !provider || !isConnected()) return;

  const maxPrevEth = document.getElementById("input-arb-max-previous").value || "0";
  const feeEth = document.getElementById("input-arb-fee").value || "0";

  try {
    const maxPrevWei = ethers.parseEther(maxPrevEth).toString();
    const feeWei = ethers.parseEther(feeEth).toString();

    const preview = buildArbitrationPreview(currentProposal.questionId, maxPrevWei, feeWei);
    document.getElementById("arb-preview").classList.remove("hidden");
    document.getElementById("arb-calldata").textContent = JSON.stringify(preview, null, 2);

    setStatus("arb-status", "Submitting arbitration request...", "info");
    document.getElementById("btn-init-arbitration").disabled = true;

    const signer = getSigner();
    const tx = await notifyArbitrationRequest(signer, currentProposal.questionId, maxPrevWei, feeWei);

    setStatus("arb-status", `Transaction sent: ${tx.hash}`, "info");
    showToast("Arbitration transaction submitted", "info");

    const receipt = await tx.wait();
    setStatus("arb-status", `Confirmed in block ${receipt.blockNumber} ✓`, "success");
    showToast("Arbitration request submitted", "success");

    const qs = await loadQuestionState(provider, currentProposal.questionId);
    questionStates.set(currentProposal.questionId, qs);

    await loadCachedData();
    const refreshed = allProposals.find((p) => p.questionId === currentProposal.questionId) || currentProposal;
    await openProposalDetail(refreshed, { updateRoute: false });
  } catch (err) {
    console.error("Arbitration error:", err);
    setStatus("arb-status", `Error: ${err.reason || err.message}`, "error");
    showToast(`Arbitration failed: ${err.reason || err.message}`, "error");
  } finally {
    document.getElementById("btn-init-arbitration").disabled = !isConnected();
  }
}

// ---- Execute Tx ----

function renderTxBundle(bundle, proposal) {
  const preview = document.getElementById("tx-bundle-preview");
  const tbody = document.getElementById("tx-bundle-tbody");
  preview.classList.remove("hidden");
  tbody.innerHTML = "";

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
    setStatus("exec-status", `Imported ${transactions.length} transaction(s)`, "success");
    showToast("Transaction bundle imported", "success");
  } catch (err) {
    setStatus("exec-status", `Import error: ${err.message}`, "error");
    showToast(`Import failed: ${err.message}`, "error");
  }
}

async function executeTx(proposal, bundle, txIndex) {
  if (!isConnected()) {
    showToast("Connect wallet first", "warning");
    return;
  }

  const tx = bundle.transactions[txIndex];
  const confirmed = window.confirm(
    `Execute transaction #${txIndex}?\n\n` +
    `To: ${tx.to}\nValue: ${tx.value} wei\nData: ${tx.data.slice(0, 66)}...\nOperation: ${tx.operation}\n\n` +
    "This calls executeProposalWithIndex on the Reality Module."
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
    showToast("Execution tx submitted", "info");

    const receipt = await result.wait();
    setStatus("exec-status", `Tx #${txIndex} executed in block ${receipt.blockNumber} ✓`, "success");
    showToast(`Transaction #${txIndex} executed successfully`, "success");
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

    if (chainId && walletChainId !== chainId) {
      showToast(`Warning: wallet chain ${walletChainId}, RPC chain ${chainId}`, "warning");
    }

    if (currentProposal) {
      const qs = questionStates.get(currentProposal.questionId) || null;
      updateVoteSection(qs);
      updateArbitrationSection(qs);
      await updateExecuteSection(currentProposal);
      await updateClaimSection(currentProposal, qs);
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
  const confirmed = window.confirm("This clears cached data and re-indexes from scratch. Continue?");
  if (!confirmed) return;

  await dbClearAll();
  allProposals = [];
  questionStates = new Map();
  currentProposal = null;
  hideDetail();
  clearProposalRoute();
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
  document.getElementById("btn-wallet").addEventListener("click", doConnectWallet);
  document.getElementById("btn-settings").addEventListener("click", toggleSettings);

  document.getElementById("btn-save-settings").addEventListener("click", doSaveSettings);
  document.getElementById("btn-reindex").addEventListener("click", doReindex);
  document.getElementById("btn-export-db").addEventListener("click", doExportDB);
  document.getElementById("btn-import-db").addEventListener("click", doImportDBClick);
  document.getElementById("file-import-db").addEventListener("change", doImportDBFile);

  document.getElementById("btn-refresh").addEventListener("click", async () => {
    if (!provider) {
      showToast("Connect to an RPC first", "warning");
      return;
    }

    updateSyncBadge("Syncing...", "warning");
    try {
      await maybeExpandBackfillCoverage();
      const { newProposals, stateUpdates } = await runIncrementalSync();
      if (newProposals.length > 0) {
        showToast(`Found ${newProposals.length} new proposal(s)`, "info");
      }
      if (stateUpdates > 0) {
        showToast(`Updated ${stateUpdates} active proposal state(s)`, "info", 2500);
      }
    } catch (err) {
      console.error("Refresh error:", err);
      showToast(`Refresh error: ${err.message}`, "error");
    }
    updateSyncBadge("Synced ✓", "success");
  });

  document.getElementById("search-proposals").addEventListener("input", refreshUI);
  document.getElementById("filter-status").addEventListener("change", refreshUI);

  document.getElementById("btn-back").addEventListener("click", () => {
    hideDetail();
    currentProposal = null;
    clearProposalRoute();
    refreshUI();
  });

  document.getElementById("btn-vote-yes").addEventListener("click", () => selectAnswer(true));
  document.getElementById("btn-vote-no").addEventListener("click", () => selectAnswer(false));
  document.getElementById("btn-submit-vote").addEventListener("click", doSubmitVote);

  document.getElementById("input-bond").addEventListener("input", () => {
    if (selectedAnswer !== null) selectAnswer(selectedAnswer === "yes");
  });
  document.getElementById("input-max-previous").addEventListener("input", () => {
    if (selectedAnswer !== null) selectAnswer(selectedAnswer === "yes");
  });

  document.getElementById("btn-init-arbitration").addEventListener("click", doInitiateArbitration);

  document.getElementById("btn-import-bundle").addEventListener("click", doImportBundle);

  document.getElementById("btn-claim-winnings").addEventListener("click", doClaimWinnings);
  document.getElementById("btn-withdraw-balance").addEventListener("click", doWithdrawBalance);
  document.getElementById("btn-scan-claims").addEventListener("click", doScanAllClaims);

  onAccountsChanged(async (accounts) => {
    if (accounts.length === 0) {
      disconnectWallet();
      updateWalletButton(null);
      if (currentProposal) {
        const qs = questionStates.get(currentProposal.questionId) || null;
        updateVoteSection(qs);
        updateArbitrationSection(qs);
        await updateExecuteSection(currentProposal);
        await updateClaimSection(currentProposal, qs);
      }
    } else {
      try {
        const { address } = await connectWallet();
        updateWalletButton(address);
      } catch {
        // ignore reconnect race
      }
    }
  });

  onChainChanged(() => {
    window.location.reload();
  });

  window.addEventListener("popstate", async () => {
    const proposalId = getProposalIdFromLocation();
    if (!proposalId) {
      hideDetail();
      currentProposal = null;
      refreshUI();
      return;
    }

    pendingDeepLinkProposalId = proposalId;
    if (provider) {
      await resolvePendingDeepLink();
    }
  });
}

// ---- Boot ----

init().catch((err) => {
  console.error("Initialization error:", err);
  showToast(`Init error: ${err.message}`, "error");
});
