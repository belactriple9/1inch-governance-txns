/**
 * contracts.js — ABI definitions, contract instantiation, and EIP-712 helpers
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import { MODULE_ADDRESS, REALITIO_ADDRESS, EIP712_TYPES } from "./config.js";

// ---- Reality Module ABI ----
export const REALITY_MODULE_ABI = [
  // Events
  "event ProposalQuestionCreated(bytes32 indexed questionId, string indexed proposalId)",

  // Read functions
  "function avatar() view returns (address)",
  "function target() view returns (address)",
  "function oracle() view returns (address)",
  "function questionCooldown() view returns (uint32)",
  "function answerExpiration() view returns (uint32)",
  "function minimumBond() view returns (uint256)",
  "function buildQuestion(string proposalId, bytes32[] txHashes) view returns (string)",
  "function questionIds(bytes32 questionHash) view returns (bytes32)",
  "function executedProposalTransactions(bytes32 questionHash, bytes32 txHash) view returns (bool)",

  // Write functions
  "function addProposal(string proposalId, bytes32[] txHashes)",
  "function executeProposalWithIndex(string proposalId, bytes32[] txHashes, address to, uint256 value, bytes data, uint8 operation, uint256 txIndex)",
];

// ---- Reality.eth v3.0 ABI ----
export const REALITIO_ABI = [
  // Events
  "event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)",
  "event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)",
  "event LogFinalize(bytes32 indexed question_id, bytes32 indexed answer)",
  "event LogNotifyOfArbitrationRequest(bytes32 indexed question_id, address indexed user)",

  // Read functions
  "function questions(bytes32) view returns (bytes32 content_hash, address arbitrator, uint32 opening_ts, uint32 timeout, uint32 finalize_ts, bool is_pending_arbitration, uint256 bounty, bytes32 best_answer, bytes32 history_hash, uint256 bond, uint256 min_bond)",
  "function isFinalized(bytes32) view returns (bool)",
  "function getFinalAnswer(bytes32) view returns (bytes32)",
  "function getBond(bytes32) view returns (uint256)",
  "function getTimeout(bytes32) view returns (uint32)",
  "function getBestAnswer(bytes32) view returns (bytes32)",
  "function balanceOf(address) view returns (uint256)",

  // Write functions
  "function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable",
  "function claimWinnings(bytes32 question_id, bytes32[] history_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)",
  "function claimMultipleAndWithdrawBalance(bytes32[] question_ids, uint256[] lengths, bytes32[] history_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)",
  "function withdraw() external",
];

// ---- Module Interface (for parsing) ----
export const moduleIface = new ethers.Interface(REALITY_MODULE_ABI);
export const realitioIface = new ethers.Interface(REALITIO_ABI);

/**
 * Create a Reality Module contract instance.
 */
export function getModuleContract(providerOrSigner) {
  return new ethers.Contract(MODULE_ADDRESS, REALITY_MODULE_ABI, providerOrSigner);
}

/**
 * Create a Reality.eth oracle contract instance.
 */
export function getRealitioContract(providerOrSigner) {
  return new ethers.Contract(REALITIO_ADDRESS, REALITIO_ABI, providerOrSigner);
}

/**
 * Calculate the EIP-712 transaction hash used by the Reality Module.
 * nonce = txIndex (position in txHashes[]).
 */
export function calcRealityModuleTxHash({ chainId, moduleAddress, tx }) {
  const domain = {
    chainId: Number(chainId),
    verifyingContract: moduleAddress || MODULE_ADDRESS,
  };
  return ethers.TypedDataEncoder.hash(domain, EIP712_TYPES, {
    to: tx.to,
    value: tx.value ?? 0,
    data: tx.data ?? "0x",
    operation: tx.operation ?? 0,
    nonce: tx.nonce ?? 0,
  });
}

/**
 * Get the topic hash for a named event from an interface.
 */
export function topicHash(iface, eventName) {
  return iface.getEvent(eventName).topicHash;
}
