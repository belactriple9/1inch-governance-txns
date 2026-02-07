/**
 * config.js — Constants, default settings, and configuration management
 */

// ---- Contract Addresses ----
export const MODULE_ADDRESS = "0xa62D2a75eb39C12e908e9F6BF50f189641692F2E";
export const REALITIO_ADDRESS = "0x5b7dD1E86623548AF054A4985F7fc8Ccbb554E2c";

// ---- Defaults ----
export const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
export const DEFAULT_BACKFILL_DAYS = 7;
export const DEFAULT_POLL_INTERVAL_SEC = 30;
export const SECONDS_PER_DAY = 86400;
export const LOG_CHUNK_SIZE = 5000; // blocks per getLogs request
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 2000;

// ---- Boolean answer encoding ----
export const ANSWER_YES = "0x0000000000000000000000000000000000000000000000000000000000000001";
export const ANSWER_NO  = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const ANSWER_INVALID = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// ---- EIP-712 ----
export const EIP712_TYPES = {
  Transaction: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * Load settings from localStorage (quick access) or use defaults.
 */
export function loadSettings() {
  const raw = localStorage.getItem("gcc_settings");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch { /* fall through */ }
  }
  return {
    rpcUrl: DEFAULT_RPC,
    rpcFallback: "",
    backfillDays: DEFAULT_BACKFILL_DAYS,
    pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
  };
}

/**
 * Persist settings to localStorage.
 */
export function saveSettings(settings) {
  localStorage.setItem("gcc_settings", JSON.stringify(settings));
}
