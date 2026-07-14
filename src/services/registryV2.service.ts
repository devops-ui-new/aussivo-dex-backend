/**
 * registryV2.service.ts — thin, fail-safe wrapper over AussivoUserRegistryV2.
 *
 * Writes go through the ChainOutbox worker (chainSync.worker.ts), NOT directly, so a gas/RPC
 * failure queues and retries instead of vanishing. This service only exposes the raw contract
 * calls (used by the worker) plus read helpers (used by admin + reconcile).
 *
 * principal is stored on-chain in CENTS (SCALE = 100): $41,680.00 -> 4168000.
 */
import { ethers } from 'ethers';
import logger from '../configs/logger.config';
import {
  BSC_PROVIDER_URL,
  BSC_CHAIN_ID,
  REGISTRY_V2_ADDRESS,
  REGISTRY_V2_OWNER_PRIVATE_KEY,
} from '../configs/constants';

export const SCALE = 100;

const ABI = [
  'function attest(address user, uint128 principal, uint32 depositCount)',
  'function attestBatch(address[] users, uint128[] principals, uint32[] depositCounts)',
  'function markGlobalSync(uint256 totalUsers, uint256 totalPrincipal)',
  'function setApyBps(uint32 apyBps)',
  'function positionOf(address user) view returns (uint256 principalCents, uint32 depositCount, uint64 updatedAt, bool registered)',
  'function totalRegisteredUsers() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function lastGlobalSyncAt() view returns (uint64)',
  'function apyBps() view returns (uint32)',
];

export function isRegistryV2Enabled(): boolean {
  return !!REGISTRY_V2_ADDRESS && !!REGISTRY_V2_OWNER_PRIVATE_KEY;
}

function getProvider(): ethers.JsonRpcProvider {
  const url = BSC_PROVIDER_URL.split(',').map((s) => s.trim()).filter(Boolean)[0] || BSC_PROVIDER_URL;
  return new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true });
}

function signer(): ethers.Wallet {
  return new ethers.Wallet(REGISTRY_V2_OWNER_PRIVATE_KEY, getProvider());
}

function writeContract(): ethers.Contract {
  return new ethers.Contract(REGISTRY_V2_ADDRESS, ABI, signer());
}

function readContract(): ethers.Contract {
  return new ethers.Contract(REGISTRY_V2_ADDRESS, ABI, getProvider());
}

/** human dollars -> uint128 cents (bigint). Truncates sub-cent. */
export function toCents(amountHuman: number): bigint {
  if (!Number.isFinite(amountHuman) || amountHuman < 0) return 0n;
  return BigInt(Math.round(amountHuman * SCALE));
}

/** Owner wallet address (for admin display) — no key exposure. */
export function registryV2Signer(): { address: string | null } {
  if (!isRegistryV2Enabled()) return { address: null };
  try { return { address: new ethers.Wallet(REGISTRY_V2_OWNER_PRIVATE_KEY).address }; }
  catch { return { address: null }; }
}

/** Signer gas balance in BNB (string), or null if disabled/unavailable. */
export async function signerGasBnb(): Promise<string | null> {
  if (!isRegistryV2Enabled()) return null;
  try {
    const w = registryV2Signer().address;
    if (!w) return null;
    const bal = await getProvider().getBalance(w);
    return ethers.formatEther(bal);
  } catch { return null; }
}

/** Raw write — used ONLY by the outbox worker. Throws on failure so the worker can retry. */
export async function attestOnChain(walletAddress: string, principalCents: number, depositCount: number): Promise<string> {
  const addr = ethers.getAddress(walletAddress);
  const tx = await writeContract().attest(addr, BigInt(principalCents), depositCount);
  logger.info(`[RegistryV2] attest ${addr} principal=${principalCents}c count=${depositCount} tx=${tx.hash}`);
  await tx.wait(1);
  return tx.hash;
}

export async function markGlobalSyncOnChain(totalUsers: number, totalPrincipalCents: number): Promise<string> {
  const tx = await writeContract().markGlobalSync(BigInt(totalUsers), BigInt(totalPrincipalCents));
  await tx.wait(1);
  return tx.hash;
}

export async function readPosition(walletAddress: string): Promise<{ principalCents: string; depositCount: number; updatedAt: number; registered: boolean } | null> {
  if (!isRegistryV2Enabled() || !ethers.isAddress(walletAddress)) return null;
  try {
    const [principalCents, depositCount, updatedAt, registered] = await readContract().positionOf(ethers.getAddress(walletAddress));
    return { principalCents: principalCents.toString(), depositCount: Number(depositCount), updatedAt: Number(updatedAt), registered };
  } catch { return null; }
}

export async function readGlobals(): Promise<{ totalUsers: number; totalPrincipalCents: string; lastGlobalSyncAt: number; apyBps: number } | null> {
  if (!isRegistryV2Enabled()) return null;
  try {
    const c = readContract();
    const [tu, tp, ls, apy] = await Promise.all([
      c.totalRegisteredUsers(), c.totalPrincipal(), c.lastGlobalSyncAt(), c.apyBps(),
    ]);
    return { totalUsers: Number(tu), totalPrincipalCents: tp.toString(), lastGlobalSyncAt: Number(ls), apyBps: Number(apy) };
  } catch { return null; }
}