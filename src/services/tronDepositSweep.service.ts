/**
 * tronDepositSweep.service.ts — TRC20 (Tron) equivalent of the BEP20 ephemeral sweep.
 *
 * Flow mirrors the EVM side exactly:
 *   1. Generate a one-time Tron address (base58) per deposit; store its key encrypted.
 *   2. User sends USDT-TRC20 to that address.
 *   3. This tick detects the balance (TronGrid), credits the user via the SAME
 *      applyDepositAccounting used for BEP20 (so accounting can't diverge).
 *   4. Fund the ephemeral with a little TRX (for energy/bandwidth), then transfer the
 *      USDT to TRON_TREASURY_ADDRESS. On success, purge the key.
 *
 * Key differences from EVM: base58 addresses, 6-decimal USDT, and gas = TRX/energy (not BNB).
 *
 * NOTE: needs `tronweb`, a TronGrid API key, TRON_TREASURY_ADDRESS, and a funded
 * TRON_GAS_FUNDER (holding TRX). Test on the Nile testnet before mainnet.
 */
import { TronWeb } from "tronweb";
import logger from "../configs/logger.config";
import PendingDepositModel from "../models/pendingDeposit.model";
import { applyDepositAccounting } from "./ephemeralDepositSweep.service";
import { encryptPrivateKeyHex, decryptPrivateKeyHex, hashPrivateKeyHexFingerprint } from "../helpers/walletCrypto.helper";
import {
  TRON_FULL_HOST,
  TRON_API_KEY,
  TRON_USDT_CONTRACT,
  TRON_USDT_DECIMALS,
  TRON_TREASURY_ADDRESS,
  TRON_GAS_FUNDER_PRIVATE_KEY,
  TRON_GAS_TOPUP_TRX,
  TRON_MAX_FUND_ATTEMPTS,
  TRON_RECLAIM_LEFTOVER,
  EPHEMERAL_WALLET_SECRET,
} from "../configs/constants";

const TICK_MS = 15_000;
const UNIT = 10 ** TRON_USDT_DECIMALS; // 1 USDT = 1e6 base units on Tron
let timer: NodeJS.Timeout | null = null;
let running = false;

function makeTronWeb(privateKey?: string): TronWeb {
  const opts: any = { fullHost: TRON_FULL_HOST };
  if (TRON_API_KEY) opts.headers = { "TRON-PRO-API-KEY": TRON_API_KEY };
  if (privateKey) opts.privateKey = privateKey;
  return new TronWeb(opts);
}

/** Generate a one-time Tron deposit address. privateKey is 64-hex (no 0x). */
export async function createTronEphemeral(): Promise<{ address: string; privateKey: string }> {
  const acct = await TronWeb.createAccount();
  return { address: acct.address.base58, privateKey: acct.privateKey };
}

export function isTronAddress(addr: string): boolean {
  try { return makeTronWeb().isAddress(addr); } catch { return false; }
}

/** Tron gas-funder TRX balance + whether it can still fund sweeps. For the admin monitor. */
export async function getTronGasFunderStatus(): Promise<{ address: string; trx: string; ok: boolean } | null> {
  if (!TRON_GAS_FUNDER_PRIVATE_KEY) return null;
  try {
    const tron = makeTronWeb(TRON_GAS_FUNDER_PRIVATE_KEY);
    const address = tron.address.fromPrivateKey(TRON_GAS_FUNDER_PRIVATE_KEY) as string;
    const balSun = Number(await tron.trx.getBalance(address));
    return { address, trx: (balSun / 1e6).toFixed(2), ok: balSun > Number(tron.toSun(TRON_GAS_TOPUP_TRX)) * 3 };
  } catch { return null; }
}

/** Human-readable USDT balance on a Tron address. */
async function getUsdtBalance(tron: TronWeb, address: string): Promise<number> {
  // TronWeb needs an owner_address set even for constant (read-only) calls, else TronGrid
  // rejects with "owner_address isn't set". Use the address being queried.
  tron.setAddress(address);
  const contract = await tron.contract().at(TRON_USDT_CONTRACT);
  const raw = await contract.balanceOf(address).call();
  return Number(raw.toString()) / UNIT;
}

/** Send TRX from the gas funder to an ephemeral address so it can pay energy for the USDT transfer. */
export async function fundTronEnergy(address: string): Promise<string> {
  if (!TRON_GAS_FUNDER_PRIVATE_KEY) { logger.warn("[TronSweep] TRON_GAS_FUNDER_PRIVATE_KEY not set — cannot fund energy"); return ""; }
  try {
    const funder = makeTronWeb(TRON_GAS_FUNDER_PRIVATE_KEY);
    const sun = Number(funder.toSun(TRON_GAS_TOPUP_TRX));
    const tx = await funder.trx.sendTransaction(address, sun);
    const txid = (tx as any)?.txid || (tx as any)?.transaction?.txID || "";
    logger.info(`[TronSweep] Funded ${TRON_GAS_TOPUP_TRX} TRX → ${address} tx=${txid}`);
    return txid;
  } catch (e: any) {
    logger.warn(`[TronSweep] energy fund failed for ${address}: ${e?.message || e}`);
    return "";
  }
}

/** Move the full USDT balance off the ephemeral address into the Tron treasury. */
async function sweepToTreasury(ephemeralAddress: string, privateKey: string, amountHuman: number): Promise<string> {
  if (!TRON_TREASURY_ADDRESS) { logger.warn("[TronSweep] TRON_TREASURY_ADDRESS not set — holding funds on ephemeral"); return ""; }
  const tron = makeTronWeb(privateKey);
  const contract = await tron.contract().at(TRON_USDT_CONTRACT);
  const amountUnits = Math.floor(amountHuman * UNIT).toString();
  const txid: string = await contract.transfer(TRON_TREASURY_ADDRESS, amountUnits).send({ feeLimit: 100_000_000 });
  logger.info(`[TronSweep] Swept ${amountHuman} USDT ${ephemeralAddress} → treasury tx=${txid}`);
  return txid;
}

/**
 * After a successful sweep, send the ephemeral's leftover TRX back to the gas funder so it isn't
 * stranded. Keeps a small reserve for the transfer's own fee, and skips dust. Fail-safe: any error
 * here is logged and ignored (the USDT is already safe in treasury).
 */
async function reclaimLeftoverTrx(address: string, privateKey: string): Promise<void> {
  if (!TRON_RECLAIM_LEFTOVER || !TRON_GAS_FUNDER_PRIVATE_KEY) return;
  try {
    const eph = makeTronWeb(privateKey);
    const funderAddr = makeTronWeb(TRON_GAS_FUNDER_PRIVATE_KEY).address.fromPrivateKey(TRON_GAS_FUNDER_PRIVATE_KEY) as string;
    const balSun = Number(await eph.trx.getBalance(address));
    const RESERVE_SUN = 1_500_000;          // ~1.5 TRX left behind for this transfer's own fee
    const MIN_RECLAIM_SUN = 2_000_000;      // don't bother reclaiming < 2 TRX of dust
    const sendSun = balSun - RESERVE_SUN;
    if (sendSun < MIN_RECLAIM_SUN) return;
    const tx = await eph.trx.sendTransaction(funderAddr, sendSun);
    const txid = (tx as any)?.txid || (tx as any)?.transaction?.txID || "";
    logger.info(`[TronSweep] reclaimed ${(sendSun / 1e6).toFixed(2)} TRX ${address} → funder tx=${txid}`);
  } catch (e: any) {
    logger.warn(`[TronSweep] reclaim leftover failed ${address}: ${e?.message || e}`);
  }
}

async function processOne(doc: any): Promise<void> {
  const tron = makeTronWeb();
  const address: string = doc.ephemeralAddress;

  let balance = 0;
  try { balance = await getUsdtBalance(tron, address); }
  catch (e: any) { logger.warn(`[TronSweep] balance check failed ${address}: ${e?.message || e}`); return; }
  if (balance <= 0) return; // nothing arrived yet

  // 1) Credit the user (idempotent) via the shared accounting path — before the sweep.
  if (!doc.userCreditedAt) {
    try {
      await applyDepositAccounting(doc, { settledAmount: balance, skipConfirmationEmail: false });
      await PendingDepositModel.findByIdAndUpdate(doc._id, {
        status: "credited", userCreditedAt: new Date(), receivedAmount: balance,
      });
      logger.info(`[TronSweep] Credited ${balance} USDT for ${address}`);
    } catch (e: any) {
      logger.error(`[TronSweep] credit failed ${address}: ${e?.message || e}`);
      return;
    }
  }

  // 2) Sweep to treasury (needs the decrypted ephemeral key + a little TRX for energy).
  if (!doc.privateKeyEncrypted) return; // already purged
  let pk = "";
  try { pk = decryptPrivateKeyHex(doc.privateKeyEncrypted, EPHEMERAL_WALLET_SECRET); }
  catch { logger.warn(`[TronSweep] decrypt failed for ${address} — cannot sweep`); return; }

  // Ensure the ephemeral can pay for the transfer (energy comes from burning TRX).
  // CRITICAL: do NOT re-fund on every tick — that drains the gas funder. Fund at most once
  // per cooldown window, then wait for the TRX to land before attempting the sweep.
  let trxBalSun = 0;
  try { trxBalSun = Number(await tron.trx.getBalance(address)); } catch { /* fall through */ }
  const needSun = Number(tron.toSun(TRON_GAS_TOPUP_TRX)) * 0.6;
  if (trxBalSun < needSun) {
    // Give up funding a deposit that never sweeps — this is what drained the funder (same address
    // funded 3–4×). After the cap it's left for manual review (shows in Sweep Health as stuck).
    if (doc.fundingHalted) {
      logger.warn(`[TronSweep] ${address}: funding halted (${doc.energyFundAttempts} attempts) — needs manual review / force-sweep`);
      return;
    }
    const FUND_COOLDOWN_MS = 3 * 60 * 1000;
    const lastFund = doc.energyFundedAt ? new Date(doc.energyFundedAt).getTime() : 0;
    if (Date.now() - lastFund > FUND_COOLDOWN_MS) {
      const attempts = (Number(doc.energyFundAttempts) || 0) + 1;
      if (attempts > TRON_MAX_FUND_ATTEMPTS) {
        await PendingDepositModel.findByIdAndUpdate(doc._id, { fundingHalted: true });
        logger.warn(`[TronSweep] ${address}: ${TRON_MAX_FUND_ATTEMPTS} fund attempts without a sweep — halting further funding to protect the gas funder`);
        return;
      }
      const tx = await fundTronEnergy(address);
      await PendingDepositModel.findByIdAndUpdate(doc._id, {
        energyFundedAt: new Date(),
        energyFundAttempts: attempts,
        ...(tx ? { gasFundTxHash: tx } : {}),
      });
    } else {
      logger.info(`[TronSweep] ${address}: waiting for energy TRX to land (funded <3m ago), TRX=${(trxBalSun / 1e6).toFixed(2)}`);
    }
    return; // wait for TRX before sweeping
  }

  try {
    const txid = await sweepToTreasury(address, pk, balance);
    if (txid) {
      await PendingDepositModel.findByIdAndUpdate(doc._id, {
        status: "matched", matchedAt: new Date(), matchedTxHash: txid, sweepTxHash: txid,
        privateKeyEncrypted: "", keyPurgedAt: new Date(),
        privateKeyHash: doc.privateKeyHash || hashPrivateKeyHexFingerprint(pk),
      });
      // Recover the ephemeral's leftover TRX back to the funder (non-blocking, fail-safe).
      await reclaimLeftoverTrx(address, pk);
    }
  } catch (e: any) {
    logger.warn(`[TronSweep] sweep failed ${address} (will retry): ${e?.message || e}`);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const docs = await PendingDepositModel.find({
      network: "trc20",
      status: { $in: ["pending", "credited"] },
      ephemeralAddress: { $exists: true, $nin: [null, ""] },
    }).limit(25);
    for (const doc of docs) {
      try { await processOne(doc); } catch (e: any) { logger.warn(`[TronSweep] processOne error: ${e?.message || e}`); }
    }
  } catch (e: any) {
    logger.warn(`[TronSweep] tick error: ${e?.message || e}`);
  } finally {
    running = false;
  }
}

export function startTronDepositSweep(): void {
  if (timer) return;
  if (!TRON_TREASURY_ADDRESS) { logger.warn("[TronSweep] disabled — TRON_TREASURY_ADDRESS not configured"); return; }
  logger.info("[TronSweep] started");
  tick();
  timer = setInterval(tick, TICK_MS);
}

export function stopTronDepositSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Admin action: immediately re-fund energy and re-run the sweep for one pending deposit (Tron). */
export async function forceSweepPending(id: string): Promise<void> {
  // Clear the fund cooldown AND the halt/attempt cap so a manual retry can top up energy right away.
  await PendingDepositModel.findByIdAndUpdate(id, {
    $unset: { energyFundedAt: 1 },
    $set: { fundingHalted: false, energyFundAttempts: 0 },
  });
  const doc = await PendingDepositModel.findById(id);
  if (doc) await processOne(doc);
}