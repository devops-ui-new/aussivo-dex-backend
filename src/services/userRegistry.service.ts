/**
 * userRegistry.service.ts — keeps the on-chain AussivoUserRegistry in sync.
 *
 * The registry is a funds-free attestation of which wallets are currently registered/active users.
 * We REGISTER a user's wallet when their first deposit is credited, and DEREGISTER it when they
 * fully exit (no active deposits left). All calls are idempotent and fail-safe: a registry error
 * NEVER blocks a deposit or withdrawal — it just logs a warning. Signed by REGISTRY_OWNER_PRIVATE_KEY.
 */
import { ethers } from "ethers";
import logger from "../configs/logger.config";
import {
  BSC_PROVIDER_URL,
  BSC_CHAIN_ID,
  REGISTRY_CONTRACT_ADDRESS,
  REGISTRY_OWNER_PRIVATE_KEY,
} from "../configs/constants";

const ABI = [
  "function register(address user)",
  "function deregister(address user)",
  "function isRegistered(address user) view returns (bool)",
  "function userCount() view returns (uint256)",
  "function getUsers() view returns (address[])",
];

function enabled(): boolean {
  return !!REGISTRY_CONTRACT_ADDRESS && !!REGISTRY_OWNER_PRIVATE_KEY;
}

function getProvider(): ethers.JsonRpcProvider {
  const url =
    BSC_PROVIDER_URL.split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0] || BSC_PROVIDER_URL;
  return new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true });
}

function readContract(): ethers.Contract {
  return new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, ABI, getProvider());
}

function writeContract(): ethers.Contract {
  const wallet = new ethers.Wallet(REGISTRY_OWNER_PRIVATE_KEY, getProvider());
  return new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, ABI, wallet);
}

export function isRegistryEnabled(): boolean {
  return enabled();
}

export async function isRegisteredOnChain(
  address?: string | null,
): Promise<boolean> {
  if (!enabled() || !address || !ethers.isAddress(address)) return false;
  try {
    return await readContract().isRegistered(address);
  } catch {
    return false;
  }
}

/** Register a wallet on-chain (idempotent). Safe to await — never throws. */
export async function registerUserOnChain(
  address?: string | null,
): Promise<void> {
  if (!enabled() || !address || !ethers.isAddress(address)) return;
  try {
    const c = writeContract();
    if (await c.isRegistered(address)) return; // already registered — no tx, no gas
    const tx = await c.register(address);
    logger.info(`[Registry] register ${address} tx=${tx.hash}`);
    await tx.wait(1);
  } catch (e: any) {
    logger.warn(
      `[Registry] register failed for ${address}: ${e?.shortMessage || e?.message || e}`,
    );
  }
}

/** Deregister a wallet on-chain (idempotent). Safe to await — never throws. */
export async function deregisterUserOnChain(
  address?: string | null,
): Promise<void> {
  if (!enabled() || !address || !ethers.isAddress(address)) return;
  try {
    const c = writeContract();
    if (!(await c.isRegistered(address))) return; // not registered — nothing to do
    const tx = await c.deregister(address);
    logger.info(`[Registry] deregister ${address} tx=${tx.hash}`);
    await tx.wait(1);
  } catch (e: any) {
    logger.warn(
      `[Registry] deregister failed for ${address}: ${e?.shortMessage || e?.message || e}`,
    );
  }
}
