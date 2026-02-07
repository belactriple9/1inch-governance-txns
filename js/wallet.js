/**
 * wallet.js — Wallet connection via injected provider (MetaMask, etc.)
 */
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";

let _signer = null;
let _walletProvider = null;
let _address = null;

/**
 * Connect to the user's injected wallet (MetaMask / EIP-1193).
 * Returns { signer, address, chainId }.
 */
export async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("No injected wallet found. Please install MetaMask or a compatible wallet.");
  }

  _walletProvider = new ethers.BrowserProvider(window.ethereum);
  await _walletProvider.send("eth_requestAccounts", []);
  _signer = await _walletProvider.getSigner();
  _address = await _signer.getAddress();
  const network = await _walletProvider.getNetwork();

  return {
    signer: _signer,
    address: _address,
    chainId: Number(network.chainId),
  };
}

/**
 * Disconnect wallet (reset local state).
 */
export function disconnectWallet() {
  _signer = null;
  _walletProvider = null;
  _address = null;
}

/**
 * Get the current signer (null if not connected).
 */
export function getSigner() {
  return _signer;
}

/**
 * Get the current wallet address (null if not connected).
 */
export function getAddress() {
  return _address;
}

/**
 * Check if wallet is connected.
 */
export function isConnected() {
  return _signer !== null;
}

/**
 * Get the wallet provider (BrowserProvider).
 */
export function getWalletProvider() {
  return _walletProvider;
}

/**
 * Listen for account/chain changes.
 */
export function onAccountsChanged(callback) {
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", callback);
  }
}

export function onChainChanged(callback) {
  if (window.ethereum) {
    window.ethereum.on("chainChanged", callback);
  }
}
