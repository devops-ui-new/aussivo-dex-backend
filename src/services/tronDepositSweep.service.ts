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
  try {
    const trxBal = await tron.trx.getBalance(address); // in sun
    if (Number(trxBal) < Number(tron.toSun(TRON_GAS_TOPUP_TRX)) * 0.6) {
      await fundTronEnergy(address);
      return; // let the next tick sweep once TRX has landed
    }
  } catch { /* if balance check fails, still attempt the sweep below */ }

  try {
    const txid = await sweepToTreasury(address, pk, balance);
    if (txid) {
      await PendingDepositModel.findByIdAndUpdate(doc._id, {
        status: "matched", matchedAt: new Date(), matchedTxHash: txid, sweepTxHash: txid,
        privateKeyEncrypted: "", keyPurgedAt: new Date(),
        privateKeyHash: doc.privateKeyHash || hashPrivateKeyHexFingerprint(pk),
      });
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