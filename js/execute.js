/**
 * execute.js — Execute approved proposals via the Reality Module
 *
 * Implements FR-8: executeProposalWithIndex, tx bundle import/management,
 * and EIP-712 tx hash verification.
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import { getModuleContract, calcRealityModuleTxHash } from "./contracts.js";
import { MODULE_ADDRESS } from "./config.js";
import { dbPut, dbGet } from "./db.js";

/**
 * Import a transaction bundle JSON and store it.
 * Expected format: [{ to, value, data, operation }]
 *
 * @param {string} proposalId
 * @param {Array} transactions - array of tx objects
 * @param {number} chainId
 * @returns {{ proposalId, transactions, txHashes }}
 */
export function importTxBundle(proposalId, transactions, chainId) {
  // Validate and normalize
  const normalized = transactions.map((tx, index) => ({
    to: ethers.getAddress(tx.to),
    value: (tx.value || "0").toString(),
    data: tx.data || "0x",
    operation: Number(tx.operation || 0),
    nonce: index, // nonce = txIndex per SRD section 6.1
  }));

  // Calculate EIP-712 hashes for each tx
  const txHashes = normalized.map((tx) =>
    calcRealityModuleTxHash({
      chainId,
      moduleAddress: MODULE_ADDRESS,
      tx,
    })
  );

  const bundle = {
    proposalId,
    transactions: normalized,
    txHashes,
  };

  return bundle;
}

/**
 * Save a tx bundle to IndexedDB.
 */
export async function saveTxBundle(bundle) {
  await dbPut("txBundles", bundle);
}

/**
 * Load a tx bundle from IndexedDB.
 */
export async function loadTxBundle(proposalId) {
  return dbGet("txBundles", proposalId);
}

/**
 * Verify that a tx bundle's computed hashes match the proposal's stored txHashes.
 */
export function verifyTxBundle(bundle, proposalTxHashes) {
  if (bundle.txHashes.length !== proposalTxHashes.length) {
    return {
      valid: false,
      reason: `Hash count mismatch: bundle has ${bundle.txHashes.length}, proposal has ${proposalTxHashes.length}`,
    };
  }

  for (let i = 0; i < bundle.txHashes.length; i++) {
    if (bundle.txHashes[i].toLowerCase() !== proposalTxHashes[i].toLowerCase()) {
      return {
        valid: false,
        reason: `Hash mismatch at index ${i}: bundle=${bundle.txHashes[i]}, proposal=${proposalTxHashes[i]}`,
      };
    }
  }

  return { valid: true, reason: "All hashes match" };
}

/**
 * Execute a single transaction from a proposal.
 *
 * @param {ethers.Signer} signer
 * @param {string} proposalId
 * @param {string[]} txHashes - all txHashes for the proposal
 * @param {object} tx - { to, value, data, operation }
 * @param {number} txIndex - index of this tx in the bundle
 */
export async function executeProposalTx(signer, proposalId, txHashes, tx, txIndex) {
  const mod = getModuleContract(signer);

  const result = await mod.executeProposalWithIndex(
    proposalId,
    txHashes,
    tx.to,
    tx.value || 0,
    tx.data || "0x",
    tx.operation || 0,
    txIndex
  );

  return result;
}

/**
 * Build a preview of the execution call (for user review).
 */
export function buildExecutePreview(proposalId, txHashes, tx, txIndex) {
  return {
    contract: "Reality Module",
    method: "executeProposalWithIndex(string, bytes32[], address, uint256, bytes, uint8, uint256)",
    params: {
      proposalId,
      txHashes,
      to: tx.to,
      value: tx.value || "0",
      data: tx.data || "0x",
      operation: tx.operation || 0,
      txIndex,
    },
  };
}
