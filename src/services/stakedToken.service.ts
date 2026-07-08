/**
 * stakedToken.service.ts — mirrors user principal on-chain via AussivoStakedToken.
 *
 * Mint an equal amount (18-dec) to the tracker address when a deposit is credited; burn the same
 * amount when principal is withdrawn. `balanceOf(tracker)` therefore tracks CURRENT total principal.
 *
 * IMPORTANT: this is an accounting mirror, NOT proof of reserves — the owner can mint/burn at will,
 * so it proves nothing about USDT actually held. It holds no funds.
 *
 * All calls are fail-safe and non-blocking: an on-chain error NEVER blocks a deposit or withdrawal,
 * it only logs a warning. Amounts are human-readable (e.g. 1.25) and converted to 18 decimals here,
 * so BEP-20 (18-dec) and TRC-20 (6-dec) deposits both mirror correctly.
 */
import { ethers } from "ethers";
import logger from "../configs/logger.config";
import {
  BSC_PROVIDER_URL,
  BSC_CHAIN_ID,
  STAKED_TOKEN_ADDRESS,
  STAKED_TOKEN_OWNER_PRIVATE_KEY,
  STAKED_TOKEN_MEMO,
} from "../configs/constants";

const ABI = [
  "function mintForDeposit(uint256 amount, string note)",
  "function burnForWithdrawal(uint256 amount, string note)",
  "function mirroredTotal() view returns (uint256)",
  "function tracker() view returns (address)",
];

function enabled(): boolean {
  return !!STAKED_TOKEN_ADDRESS && !!STAKED_TOKEN_OWNER_PRIVATE_KEY;
}

function getProvider(): ethers.JsonRpcProvider {
  const url =
    BSC_PROVIDER_URL.split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0] || BSC_PROVIDER_URL;
  return new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true });
}

function writeContract(): ethers.Contract {
  const wallet = new ethers.Wallet(
    STAKED_TOKEN_OWNER_PRIVATE_KEY,
    getProvider(),
  );
  return new ethers.Contract(STAKED_TOKEN_ADDRESS, ABI, wallet);
}

/** Convert a human amount (1.25) to 18-dec base units, truncating beyond 18 dp. */
function toUnits(amountHuman: number): bigint | null {
  if (!Number.isFinite(amountHuman) || amountHuman <= 0) return null;
  const fixed = amountHuman.toFixed(18);
  try {
    const v = ethers.parseUnits(fixed, 18);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function isStakedTokenEnabled(): boolean {
  return enabled();
}

/** Current mirrored principal (human-readable). Returns null if disabled/unavailable. */
export async function getMirroredTotal(): Promise<string | null> {
  if (!enabled()) return null;
  try {
    const c = new ethers.Contract(STAKED_TOKEN_ADDRESS, ABI, getProvider());
    return ethers.formatUnits(await c.mirroredTotal(), 18);
  } catch {
    return null;
  }
}

/** Build the on-chain memo. Contract caps it at 200 bytes. */
function buildNote(action: string, ref?: string): string {
  const base = `${STAKED_TOKEN_MEMO} | ${action}`;
  const note = ref ? `${base} | ref: ${ref}` : base;
  return note.slice(0, 200);
}

/** Mint mirror tokens for a credited deposit. Safe to await — never throws. */
export async function mintForDeposit(
  amountHuman: number,
  ref?: string,
): Promise<void> {
  if (!enabled()) return;
  const units = toUnits(amountHuman);
  if (!units) return;
  const note = buildNote("deposit", ref);
  try {
    const tx = await writeContract().mintForDeposit(units, note);
    logger.info(
      `[StakedToken] mint ${amountHuman} note="${note}" tx=${tx.hash}`,
    );
    await tx.wait(1);
  } catch (e: any) {
    logger.warn(
      `[StakedToken] mint failed for ${amountHuman}: ${e?.shortMessage || e?.message || e}`,
    );
  }
}

/** Burn mirror tokens when principal is withdrawn. Safe to await — never throws. */
export async function burnForWithdrawal(
  amountHuman: number,
  ref?: string,
): Promise<void> {
  if (!enabled()) return;
  const units = toUnits(amountHuman);
  if (!units) return;
  const note = buildNote("redemption", ref);
  try {
    const tx = await writeContract().burnForWithdrawal(units, note);
    logger.info(
      `[StakedToken] burn ${amountHuman} note="${note}" tx=${tx.hash}`,
    );
    await tx.wait(1);
  } catch (e: any) {
    logger.warn(
      `[StakedToken] burn failed for ${amountHuman}: ${e?.shortMessage || e?.message || e}`,
    );
  }
}
