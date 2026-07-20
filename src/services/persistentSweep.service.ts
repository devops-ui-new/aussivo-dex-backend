/**
 * persistentSweep.service.ts — moves credited funds from permanent deposit addresses
 * to treasury, on both BSC and Tron.
 *
 * THE INVARIANT (this is the whole point of the file)
 *
 *     onAddressExpected = creditedTotal − sweptTotal
 *     sweepable         = min(actualBalance, onAddressExpected)
 *
 * We only ever sweep value we have ALREADY booked to the user. If the on-chain
 * balance is larger than what we've credited, the scanner is behind — we sweep the
 * credited portion and leave the rest, rather than moving a user's money into
 * treasury without it appearing in their portfolio. The excess is flagged for the
 * admin monitor and picked up automatically once the scanner catches up.
 *
 * KEYS ARE NEVER PURGED. There is no keyPurgedAt on deposit_addresses and no $unset
 * anywhere in this file. A sweep that fails for any reason — no gas, RPC down, reverted
 * tx, unconfirmed broadcast — leaves the address fully recoverable, forever. This is
 * the explicit fix for "the encrypted key didn't purge at all, so we should have a
 * secured way, even if the amount stuck can be retrievable".
 *
 * Sweeping is decoupled from crediting: a stuck sweep never delays a user's balance.
 */
import { ethers } from "ethers";
import { TronWeb } from "tronweb";
import {
  BSC_CHAIN_ID,
  BSC_PROVIDER_URL,
  TREASURY_WALLET_ADDRESS,
  GAS_FUNDER_PRIVATE_KEY,
  USDT_CONTRACT_ADDRESS,
  USDC_CONTRACT_ADDRESS,
  TRON_FULL_HOST,
  TRON_API_KEY,
  TRON_USDT_CONTRACT,
  TRON_USDT_DECIMALS,
  TRON_TREASURY_ADDRESS,
  TRON_GAS_FUNDER_PRIVATE_KEY,
  TRON_GAS_TOPUP_TRX,
  PERSISTENT_DEPOSIT_ADDRESSES,
  SWEEP_INTERVAL_MS,
  SWEEP_MIN_AMOUNT_USD,
  DEPOSIT_BALANCE_FALLBACK,
  DEPOSIT_BALANCE_FALLBACK_CHAINS,
  DEPOSIT_BALANCE_FALLBACK_DELAY_MS,
} from "../configs/constants";
import DepositAddressModel from "../models/depositAddress.model";
import DepositSweepModel from "../models/depositSweep.model";
import DepositCreditModel from "../models/depositCredit.model";
import logger from "../configs/logger.config";
import { resolveDepositPrivateKey, stripHexPrefix } from "../helpers/depositKey.helper";
import { creditFromBalance } from "./depositAddress.service";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const GAS_TOPUP_WEI = 350_000_000_000_000n; // 0.00035 BNB
const MIN_GAS_WEI = 30_000_000_000_000n;
const BEP20_DECIMALS = 18;
const TRON_UNIT = 10 ** TRON_USDT_DECIMALS;

let evmProvider: ethers.JsonRpcProvider | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
const inFlight = new Set<string>();

function getEvmProvider(): ethers.JsonRpcProvider {
  if (!evmProvider) {
    const url = BSC_PROVIDER_URL.split(",").map((s) => s.trim()).filter(Boolean)[0] || BSC_PROVIDER_URL;
    evmProvider = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true });
  }
  return evmProvider;
}

function makeTronWeb(privateKey?: string): TronWeb {
  const opts: any = { fullHost: TRON_FULL_HOST };
  if (TRON_API_KEY) opts.headers = { "TRON-PRO-API-KEY": TRON_API_KEY };
  if (privateKey) opts.privateKey = privateKey;
  return new TronWeb(opts);
}

/** Decimal128 → BigInt, tolerating "1.2E+21" style output from the driver. */
function d128ToBigInt(v: any): bigint {
  if (v == null) return 0n;
  let s = String(v).trim();
  if (!s || s === "0") return 0n;
  if (/[eE]/.test(s)) {
    const [mant, expRaw] = s.split(/[eE]/);
    const exp = parseInt(expRaw, 10);
    const neg = mant.startsWith("-");
    const [intPart, fracPart = ""] = mant.replace(/^[-+]/, "").split(".");
    const digits = intPart + fracPart;
    const pad = exp - fracPart.length;
    s = (neg ? "-" : "") + (pad >= 0 ? digits + "0".repeat(pad) : digits.slice(0, digits.length + pad));
  }
  s = s.split(".")[0];
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/**
 * TronWeb returns failures as a RESOLVED object, not a thrown error:
 *   { result: false, code: 'CONTRACT_VALIDATE_ERROR', message: '<hex>' }
 * A try/catch alone therefore silently swallows every failed send. This normalises
 * the response so the real reason reaches the logs.
 */
function readTronResult(res: any): { ok: boolean; txid: string; error: string } {
  const txid = res?.txid || res?.transaction?.txID || res?.txID || "";
  if (res?.result === false || res?.code) {
    let msg = String(res?.message || res?.code || "unknown");
    if (/^[0-9a-fA-F]+$/.test(msg) && msg.length % 2 === 0) {
      try { msg = Buffer.from(msg, "hex").toString("utf8"); } catch { /* keep hex */ }
    }
    return { ok: false, txid, error: `${res?.code || "FAILED"}: ${msg}` };
  }
  if (!txid) return { ok: false, txid: "", error: "no txid returned from broadcast" };
  return { ok: true, txid, error: "" };
}

async function recordSweepTotals(addrId: any, amountBaseUnits: bigint): Promise<void> {
  await DepositAddressModel.findByIdAndUpdate(addrId, {
    $inc: { sweptTotal: amountBaseUnits.toString() as any },
    $set: { lastSweepAt: new Date(), lastSweepError: "", sweepFailureCount: 0 },
  });
}

async function noteFailure(addrId: any, err: string): Promise<void> {
  await DepositAddressModel.findByIdAndUpdate(addrId, {
    $inc: { sweepFailureCount: 1 },
    $set: { lastSweepError: err.slice(0, 400) },
  });
}

/**
 * Compute how much of the on-chain balance we are permitted to move.
 * Also flags (but does not act on) an unexplained excess.
 */
async function sweepableAmount(
  doc: any,
  actualBalance: bigint,
  decimals: number,
  asset: "USDT" | "USDC"
): Promise<bigint> {
  const credited = d128ToBigInt(doc.creditedTotal);
  const swept = d128ToBigInt(doc.sweptTotal);
  const expected = credited > swept ? credited - swept : 0n;

  if (actualBalance > expected) {
    const excess = actualBalance - expected;
    if (!doc.unexplainedBalanceSince) {
      await DepositAddressModel.findByIdAndUpdate(doc._id, {
        $set: { unexplainedBalanceSince: new Date() },
      });
      logger.warn(
        `[PersistentSweep] ${doc.address}: balance ${actualBalance} exceeds credited-unswept ${expected}. ` +
          `Excess held — not swept — until it is booked to the user.`
      );
      return actualBalance < expected ? actualBalance : expected;
    }

    // BALANCE FALLBACK: if the scanner still hasn't booked this after a settling delay,
    // credit it from the balance so an RPC limitation can never strand a user's deposit.
    // The delay avoids crediting a transfer the scanner is about to pick up properly.
    const waitedMs = Date.now() - new Date(doc.unexplainedBalanceSince).getTime();
    // Only on chains whose scanner is unreliable. Running it alongside a WORKING scanner
    // double-credits, because the two paths use different idempotency keys.
    const fallbackAllowed =
      DEPOSIT_BALANCE_FALLBACK && DEPOSIT_BALANCE_FALLBACK_CHAINS.includes(doc.network);
    if (fallbackAllowed && waitedMs >= DEPOSIT_BALANCE_FALLBACK_DELAY_MS) {
      try {
        const r = await creditFromBalance(doc, excess, decimals, asset, credited + excess);
        if (r === "credited") {
          const fresh = await DepositAddressModel.findById(doc._id).lean();
          const c2 = d128ToBigInt((fresh as any)?.creditedTotal);
          const s2 = d128ToBigInt((fresh as any)?.sweptTotal);
          const exp2 = c2 > s2 ? c2 - s2 : 0n;
          return actualBalance < exp2 ? actualBalance : exp2;
        }
      } catch (e: any) {
        logger.error(`[PersistentSweep] balance-fallback credit failed for ${doc.address}: ${e?.message || e}`);
      }
    } else if (fallbackAllowed) {
      const left = Math.ceil((DEPOSIT_BALANCE_FALLBACK_DELAY_MS - waitedMs) / 1000);
      logger.info(`[PersistentSweep] ${doc.address}: uncredited balance detected, crediting from balance in ~${left}s if the scanner hasn't booked it`);
    }
  } else if (doc.unexplainedBalanceSince) {
    await DepositAddressModel.findByIdAndUpdate(doc._id, { $set: { unexplainedBalanceSince: null } });
  }

  return actualBalance < expected ? actualBalance : expected;
}

// ─────────────────────────────────────────────────────────────────────────────
// BSC
// ─────────────────────────────────────────────────────────────────────────────

async function fundEvmGas(address: string): Promise<string> {
  if (!GAS_FUNDER_PRIVATE_KEY) return "";
  try {
    const p = getEvmProvider();
    const funder = new ethers.Wallet(GAS_FUNDER_PRIVATE_KEY, p);
    const tx = await funder.sendTransaction({ to: address, value: GAS_TOPUP_WEI });
    await tx.wait(1);
    return tx.hash;
  } catch (e: any) {
    logger.warn(`[PersistentSweep] EVM gas fund failed ${address}: ${e?.message || e}`);
    return "";
  }
}

/**
 * Settle sweeps that were broadcast but whose confirmation we never recorded.
 *
 * A sweep can succeed on-chain while our confirmation poll times out (TronGrid lag, RPC
 * hiccup). Older logic then marked the row 'failed' and never incremented sweptTotal —
 * so the funds sat in treasury while the books said "awaiting sweep" forever, and the
 * balance read 0 so nothing could self-correct.
 *
 * This runs BEFORE any balance check and re-verifies every sweep that has a txHash,
 * including ones previously marked 'failed', because a txHash means it WAS broadcast and
 * its true outcome is knowable from the chain.
 */
/**
 * Recompute creditedTotal / sweptTotal from the LEDGERS, not from cached counters.
 *
 * The cached fields were maintained by $inc at the moment of each event. Any interruption
 * — an RPC timeout after a transfer already succeeded, a crash between two writes — left
 * them permanently wrong, and nothing recomputed them. That is how a swept address kept
 * showing "awaiting sweep" forever.
 *
 * deposit_credits and deposit_sweeps are append-only records of what actually happened,
 * so summing them is authoritative. Running this every tick makes the totals self-healing:
 * a cache that drifts is corrected on the next pass rather than staying wrong.
 */
async function recomputeTotals(doc: any): Promise<{ credited: bigint; swept: bigint }> {
  const [creditRows, sweepRows] = await Promise.all([
    DepositCreditModel.find({ addressId: doc._id, status: "credited" }).select("amountBaseUnits").lean(),
    DepositSweepModel.find({ addressId: doc._id, status: "confirmed" }).select("amountBaseUnits").lean(),
  ]);

  let credited = 0n;
  let swept = 0n;
  for (const r of creditRows as any[]) { try { credited += BigInt(r.amountBaseUnits); } catch { /* skip malformed */ } }
  for (const r of sweepRows as any[]) { try { swept += BigInt(r.amountBaseUnits); } catch { /* skip malformed */ } }

  const cachedCredited = d128ToBigInt(doc.creditedTotal);
  const cachedSwept = d128ToBigInt(doc.sweptTotal);

  if (cachedCredited !== credited || cachedSwept !== swept) {
    await DepositAddressModel.findByIdAndUpdate(doc._id, {
      $set: {
        creditedTotal: credited.toString(),
        sweptTotal: swept.toString(),
        creditsCount: creditRows.length,
      },
    });
    logger.info(
      `[PersistentSweep] ${doc.address}: totals corrected from ledger — ` +
        `credited ${cachedCredited}→${credited}, swept ${cachedSwept}→${swept}`
    );
    doc.creditedTotal = credited.toString();
    doc.sweptTotal = swept.toString();
  }
  return { credited, swept };
}

async function reconcileBroadcastSweeps(doc: any): Promise<void> {
  const rows = await DepositSweepModel.find({
    addressId: doc._id,
    status: { $in: ["broadcast", "failed"] },
    txHash: { $nin: ["", null] },
  }).sort({ createdAt: 1 });

  for (const sw of rows) {
    let confirmed: boolean | null = null;

    if (doc.network === "trc20") {
      confirmed = await confirmTronTx(sw.txHash, 3, 2000);
    } else {
      const r = await readOrNull(`receipt ${sw.txHash}`, () =>
        getEvmProvider().getTransactionReceipt(sw.txHash)
      );
      confirmed = r == null ? null : r.status === 1;
    }

    if (confirmed === true) {
      await DepositSweepModel.findByIdAndUpdate(sw._id, {
        $set: { status: "confirmed", confirmedAt: new Date(), error: "" },
      });
      await recordSweepTotals(doc._id, BigInt(sw.amountBaseUnits));
      await DepositAddressModel.findByIdAndUpdate(doc._id, { $set: { lastSweepTxHash: sw.txHash } });
      logger.info(
        `[PersistentSweep] reconciled sweep ${sw.txHash} (${sw.amount} ${sw.asset}) for ${doc.address} — books now match chain`
      );
    } else if (confirmed === false && sw.status !== "failed") {
      await DepositSweepModel.findByIdAndUpdate(sw._id, {
        $set: { status: "failed", error: "reverted or not found on chain" },
      });
      logger.warn(`[PersistentSweep] sweep ${sw.txHash} did not succeed — funds remain on the address, will retry`);
    }
    // confirmed === null: could not verify. Leave the row alone and try again next tick.
  }
}

async function sweepEvmToken(doc: any, tokenAddr: string, asset: "USDT" | "USDC"): Promise<void> {
  const p = getEvmProvider();
  const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, p);
  const balance: bigint = await erc20.balanceOf(doc.address);
  if (balance === 0n) return;

  const amount = await sweepableAmount(doc, balance, BEP20_DECIMALS, asset);
  if (amount === 0n) return;

  const human = Number(ethers.formatUnits(amount, BEP20_DECIMALS));
  if (human < SWEEP_MIN_AMOUNT_USD) return; // leave dust; it accumulates and sweeps later

  if (!TREASURY_WALLET_ADDRESS || !ethers.isAddress(TREASURY_WALLET_ADDRESS)) {
    logger.error("[PersistentSweep] TREASURY_WALLET_ADDRESS missing — holding funds (key is retained, fully recoverable)");
    return;
  }

  // Key is DERIVED or decrypted here and never written anywhere.
  const pk = resolveDepositPrivateKey(doc);
  const wallet = new ethers.Wallet(pk, p);
  if (wallet.address.toLowerCase() !== String(doc.addressLookup).toLowerCase()) {
    await noteFailure(doc._id, "key/address mismatch");
    logger.error(`[PersistentSweep] Key/address mismatch for ${doc.address} — refusing to sweep`);
    return;
  }

  const gasRead = await readOrNull(`BNB balance of ${doc.address}`, () => p.getBalance(doc.address));
  if (gasRead === null) {
    logger.warn(`[PersistentSweep] ${doc.address}: BNB balance unreadable — skipping tick, NOT re-funding`);
    return;
  }
  let gas = gasRead;
  if (gas < MIN_GAS_WEI) {
    await fundEvmGas(doc.address);
    gas = (await readOrNull(`BNB balance of ${doc.address}`, () => p.getBalance(doc.address))) ?? gas;
  }
  if (gas < MIN_GAS_WEI) {
    await noteFailure(doc._id, "insufficient BNB for gas");
    logger.warn(`[PersistentSweep] ${doc.address}: no gas — retrying later. Funds safe, key retained.`);
    return;
  }

  const sweep = await DepositSweepModel.create({
    addressId: doc._id,
    userId: doc.userId,
    network: "bep20",
    asset,
    fromAddress: doc.address,
    toAddress: TREASURY_WALLET_ADDRESS,
    amountBaseUnits: amount.toString(),
    amount: human,
    status: "broadcast",
  });

  try {
    const erc20w = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    const tx = await erc20w.transfer(TREASURY_WALLET_ADDRESS, amount, { gasLimit: 150_000n });
    await DepositSweepModel.findByIdAndUpdate(sweep._id, { $set: { txHash: tx.hash } });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`sweep tx reverted (${tx.hash})`);

    await DepositSweepModel.findByIdAndUpdate(sweep._id, {
      $set: { status: "confirmed", confirmedAt: new Date(), txHash: receipt.hash || tx.hash },
    });
    await recordSweepTotals(doc._id, amount);
    await DepositAddressModel.findByIdAndUpdate(doc._id, {
      $set: { lastSweepTxHash: receipt.hash || tx.hash },
    });
    logger.info(`[PersistentSweep] BEP20 swept ${human} ${asset} ${doc.address} → treasury tx=${tx.hash}`);
  } catch (e: any) {
    await DepositSweepModel.findByIdAndUpdate(sweep._id, {
      $set: { status: "failed", error: String(e?.message || e).slice(0, 400) },
    });
    await noteFailure(doc._id, String(e?.message || e));
    logger.warn(`[PersistentSweep] BEP20 sweep failed ${doc.address} (key retained, will retry): ${e?.message || e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tron
// ─────────────────────────────────────────────────────────────────────────────

/** Broadcast ≠ executed on Tron. Require a SUCCESS receipt before counting a sweep. */
async function confirmTronTx(txid: string, tries = 10, delayMs = 3000): Promise<boolean> {
  if (!txid) return false;
  const tron = makeTronWeb();
  for (let i = 0; i < tries; i++) {
    try {
      const info: any = await tron.trx.getTransactionInfo(txid);
      if (info && info.id) {
        if (info.receipt?.result && info.receipt.result !== "SUCCESS") return false;
        if (info.receipt?.result === "SUCCESS" || info.blockNumber) return true;
      }
    } catch {
      /* not indexed yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Read a value that MUST NOT be guessed. Returns null when the network could not be
 * read, so callers can distinguish "the answer is zero" from "I could not find out".
 *
 * This distinction is the whole point. Treating an unreadable balance as 0 makes the
 * sweeper re-fund an address that already has TRX, forever — the exact loop that
 * burned gas here. A failed read is not a fact.
 */
async function readOrNull<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T | null> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status || e?.status;
      await new Promise((r) => setTimeout(r, (status === 429 ? 1500 : 600) * (i + 1)));
    }
  }
  logger.warn(`[PersistentSweep] could not read ${label}: ${lastErr?.message || lastErr}`);
  return null;
}

async function sweepTron(doc: any): Promise<void> {
  if (!TRON_TREASURY_ADDRESS) return;

  const tron = makeTronWeb();
  tron.setAddress(doc.address);

  const rawBal = await readOrNull(`USDT balance of ${doc.address}`, async () => {
    const contract = await tron.contract().at(TRON_USDT_CONTRACT);
    return await contract.balanceOf(doc.address).call();
  });
  if (rawBal === null) return; // unknown — retry next tick, never assume empty
  const balance = BigInt(rawBal.toString());
  if (balance === 0n) return;

  const amount = await sweepableAmount(doc, balance, TRON_USDT_DECIMALS, "USDT");
  if (amount === 0n) return;

  const human = Number(amount) / TRON_UNIT;
  if (human < SWEEP_MIN_AMOUNT_USD) return;

  const pk = stripHexPrefix(resolveDepositPrivateKey(doc));

  // Energy check. A failed read here previously became "0 TRX", so the sweeper kept
  // re-funding an address that was already funded. Unknown now means "skip this tick".
  const trxRead = await readOrNull(`TRX balance of ${doc.address}`, () => tron.trx.getBalance(doc.address));
  if (trxRead === null) {
    logger.warn(`[PersistentSweep] ${doc.address}: TRX balance unreadable — skipping tick, NOT re-funding`);
    await noteFailure(doc._id, "TRX balance unreadable (TronGrid error/rate limit)");
    return;
  }
  const trxSun = Number(trxRead);
  const needSun = Number(makeTronWeb().toSun(TRON_GAS_TOPUP_TRX)) * 0.6;
  logger.info(`[PersistentSweep] ${doc.address}: TRX ${(trxSun / 1e6).toFixed(2)} (needs ${(needSun / 1e6).toFixed(2)} to sweep)`);
  if (trxSun < needSun) {
    if (!TRON_GAS_FUNDER_PRIVATE_KEY) {
      await noteFailure(doc._id, "TRON_GAS_FUNDER_PRIVATE_KEY is not set");
      logger.error("[PersistentSweep] Tron sweeps need TRON_GAS_FUNDER_PRIVATE_KEY");
      return;
    }

    const last = doc.lastEnergyFundAt ? new Date(doc.lastEnergyFundAt).getTime() : 0;
    if (Date.now() - last < 3 * 60 * 1000) {
      logger.info(
        `[PersistentSweep] ${doc.address}: waiting for energy TRX (funded <3m ago, has ${(trxSun / 1e6).toFixed(2)}, needs ${(needSun / 1e6).toFixed(2)})`
      );
      return;
    }

    try {
      const funder = makeTronWeb(TRON_GAS_FUNDER_PRIVATE_KEY);
      const funderAddr = funder.address.fromPrivateKey(TRON_GAS_FUNDER_PRIVATE_KEY) as string;
      const sun = Number(funder.toSun(TRON_GAS_TOPUP_TRX));

      // Sending to a brand-new Tron address also pays an account-activation fee
      // (~1 TRX), so require headroom rather than an exact balance.
      const funderRead = await readOrNull(`funder balance ${funderAddr}`, () => funder.trx.getBalance(funderAddr));
      if (funderRead === null) {
        logger.warn(`[PersistentSweep] funder balance unreadable — not sending blind`);
        return;
      }
      const funderSun = Number(funderRead);
      if (funderSun < sun + 2_000_000) {
        const msg = `gas funder ${funderAddr} has ${(funderSun / 1e6).toFixed(2)} TRX, needs ${((sun + 2_000_000) / 1e6).toFixed(2)}`;
        await noteFailure(doc._id, msg);
        logger.error(`[PersistentSweep] ${msg}`);
        return;
      }

      logger.info(
        `[PersistentSweep] ${doc.address}: sending ${TRON_GAS_TOPUP_TRX} TRX from ${funderAddr} (funder has ${(funderSun / 1e6).toFixed(2)})`
      );

      const res: any = await funder.trx.sendTransaction(doc.address, sun);
      const { ok, txid, error } = readTronResult(res);

      await DepositAddressModel.findByIdAndUpdate(doc._id, {
        $set: { lastEnergyFundAt: new Date(), lastEnergyFundTx: txid || "" },
      });

      if (!ok) {
        await noteFailure(doc._id, `energy fund rejected — ${error}`);
        logger.error(`[PersistentSweep] ${doc.address}: energy fund REJECTED — ${error}`);
        return;
      }

      logger.info(`[PersistentSweep] ${doc.address}: funded ${TRON_GAS_TOPUP_TRX} TRX tx=${txid}`);
    } catch (e: any) {
      await noteFailure(doc._id, `energy fund threw: ${e?.message || e}`);
      logger.error(`[PersistentSweep] ${doc.address}: energy fund threw — ${e?.message || e}`);
    }
    return; // wait for TRX before attempting the transfer
  }

  const sweep = await DepositSweepModel.create({
    addressId: doc._id,
    userId: doc.userId,
    network: "trc20",
    asset: "USDT",
    fromAddress: doc.address,
    toAddress: TRON_TREASURY_ADDRESS,
    amountBaseUnits: amount.toString(),
    amount: human,
    status: "broadcast",
  });

  try {
    const signed = makeTronWeb(pk);
    const c = await signed.contract().at(TRON_USDT_CONTRACT);
    const raw: any = await c.transfer(TRON_TREASURY_ADDRESS, amount.toString()).send({ feeLimit: 100_000_000 });
    const txid: string = typeof raw === "string" ? raw : readTronResult(raw).txid;
    if (!txid) {
      const why = typeof raw === "string" ? "empty txid" : readTronResult(raw).error;
      await DepositSweepModel.findByIdAndUpdate(sweep._id, { $set: { status: "failed", error: why } });
      await noteFailure(doc._id, `sweep broadcast rejected — ${why}`);
      logger.error(`[PersistentSweep] ${doc.address}: sweep broadcast REJECTED — ${why}`);
      return;
    }
    await DepositSweepModel.findByIdAndUpdate(sweep._id, { $set: { txHash: txid } });

    const ok = await confirmTronTx(txid);
    if (!ok) {
      // NOT confirmed *yet* — which is not the same as failed. Leave the row as
      // 'broadcast' so reconcileBroadcastSweeps re-verifies it on later ticks.
      // Marking it failed here is exactly how a successful sweep got lost before:
      // the USDT left the address, the books never recorded it, and the balance
      // then read 0 so nothing could ever reconcile it.
      await noteFailure(doc._id, `sweep ${txid} awaiting confirmation`);
      logger.warn(
        `[PersistentSweep] TRON sweep ${txid} not confirmed within the window — keeping it as broadcast and re-verifying next tick`
      );
      return;
    }

    await DepositSweepModel.findByIdAndUpdate(sweep._id, {
      $set: { status: "confirmed", confirmedAt: new Date() },
    });
    await recordSweepTotals(doc._id, amount);
    await DepositAddressModel.findByIdAndUpdate(doc._id, { $set: { lastSweepTxHash: txid } });
    logger.info(`[PersistentSweep] TRC20 swept ${human} USDT ${doc.address} → treasury tx=${txid}`);
  } catch (e: any) {
    await DepositSweepModel.findByIdAndUpdate(sweep._id, {
      $set: { status: "failed", error: String(e?.message || e).slice(0, 400) },
    });
    await noteFailure(doc._id, String(e?.message || e));
    logger.warn(`[PersistentSweep] TRON sweep failed ${doc.address} (key retained, will retry): ${e?.message || e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function sweepOne(doc: any): Promise<void> {
  const id = String(doc._id);
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    // Settle any previously-broadcast sweep FIRST. Must run before the balance checks,
    // which return early on an empty address and would otherwise strand the books.
    await reconcileBroadcastSweeps(doc);
    // Then re-derive the totals from the ledgers so a drifted cache self-corrects.
    const fresh = (await DepositAddressModel.findById(doc._id)) || doc;
    await recomputeTotals(fresh);

    if (fresh.network === "trc20") {
      await sweepTron(fresh);
    } else {
      await sweepEvmToken(fresh, USDT_CONTRACT_ADDRESS, "USDT");
      if (USDC_CONTRACT_ADDRESS) await sweepEvmToken(fresh, USDC_CONTRACT_ADDRESS, "USDC");
    }
  } catch (e: any) {
    await noteFailure(doc._id, String(e?.message || e));
    logger.error(`[PersistentSweep] error on ${doc.address}: ${e?.message || e}`);
  } finally {
    inFlight.delete(id);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Only addresses that plausibly hold value: something credited but not yet swept,
    // or a recent inflow. Keeps RPC cost proportional to activity, not user count.
    const candidates = await DepositAddressModel.find({
      status: "active",
      // Includes addresses with no credits yet: with the balance fallback the sweeper
      // is also a detector, so it must look at every live address.
      ...(DEPOSIT_BALANCE_FALLBACK ? {} : {
        $or: [{ creditsCount: { $gt: 0 } }, { unexplainedBalanceSince: { $ne: null } }],
      }),
    })
      .sort({ lastSweepAt: 1 })
      .limit(50);

    let owedCount = 0;
    for (const doc of candidates) {
      const credited = d128ToBigInt(doc.creditedTotal);
      const swept = d128ToBigInt(doc.sweptTotal);
      // With the fallback on we must still check the chain, because an uncredited
      // deposit looks exactly like "nothing owed" until we read balanceOf.
      if (!DEPOSIT_BALANCE_FALLBACK && credited <= swept && !doc.unexplainedBalanceSince) continue;
      owedCount++;
      await sweepOne(doc);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (owedCount === 0) {
      logger.info(`[PersistentSweep] nothing to sweep (${candidates.length} address(es) checked, all settled)`);
    } else {
      logger.info(`[PersistentSweep] processed ${owedCount} address(es) with funds owed to treasury`);
    }
  } catch (e: any) {
    logger.error(`[PersistentSweep] tick error: ${e?.message || e}`);
  } finally {
    running = false;
  }
}

export function startPersistentSweep(): void {
  if (timer) return;
  if (!PERSISTENT_DEPOSIT_ADDRESSES) {
    logger.info("[PersistentSweep] disabled (PERSISTENT_DEPOSIT_ADDRESSES=false)");
    return;
  }
  logger.info(`[PersistentSweep] started — every ${SWEEP_INTERVAL_MS / 1000}s. Keys are never purged.`);
  void tick();
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
}

export function stopPersistentSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Admin: force an immediate sweep attempt for one address. */
export async function forceSweepAddress(addressId: string): Promise<void> {
  const doc = await DepositAddressModel.findById(addressId);
  if (!doc) throw new Error("Deposit address not found");
  await sweepOne(doc);
}

/**
 * Admin recovery: move an EXACT amount (or everything) off a deposit address to any
 * destination. This is the manual escape hatch that the old design made impossible
 * once the key was purged. Bypasses the credited-only invariant deliberately, so it
 * is the one place that can rescue funds the scanner never booked.
 */
export async function recoverFromAddress(
  addressId: string,
  destination: string,
  amountHuman?: number
): Promise<{ txHash: string; amount: number }> {
  const doc = await DepositAddressModel.findById(addressId);
  if (!doc) throw new Error("Deposit address not found");
  const pk = resolveDepositPrivateKey(doc);

  if (doc.network === "trc20") {
    const tron = makeTronWeb();
    tron.setAddress(doc.address);
    const c = await tron.contract().at(TRON_USDT_CONTRACT);
    const bal = BigInt((await c.balanceOf(doc.address).call()).toString());
    const amt = amountHuman != null ? BigInt(Math.floor(amountHuman * TRON_UNIT)) : bal;
    if (amt <= 0n || amt > bal) throw new Error(`Invalid amount (balance ${Number(bal) / TRON_UNIT})`);
    const signed = makeTronWeb(stripHexPrefix(pk));
    const sc = await signed.contract().at(TRON_USDT_CONTRACT);
    const txid: string = await sc.transfer(destination, amt.toString()).send({ feeLimit: 100_000_000 });
    if (!(await confirmTronTx(txid))) throw new Error(`Recovery tx ${txid} not confirmed`);
    logger.warn(`[PersistentSweep] MANUAL RECOVERY ${Number(amt) / TRON_UNIT} USDT ${doc.address} → ${destination} tx=${txid}`);
    return { txHash: txid, amount: Number(amt) / TRON_UNIT };
  }

  const p = getEvmProvider();
  const wallet = new ethers.Wallet(pk, p);
  const erc20 = new ethers.Contract(USDT_CONTRACT_ADDRESS, ERC20_ABI, wallet);
  const bal: bigint = await erc20.balanceOf(doc.address);
  const amt = amountHuman != null ? ethers.parseUnits(String(amountHuman), BEP20_DECIMALS) : bal;
  if (amt <= 0n || amt > bal) throw new Error(`Invalid amount (balance ${ethers.formatUnits(bal, BEP20_DECIMALS)})`);
  if ((await p.getBalance(doc.address)) < MIN_GAS_WEI) await fundEvmGas(doc.address);
  const tx = await erc20.transfer(ethers.getAddress(destination), amt, { gasLimit: 150_000n });
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`Recovery tx reverted (${tx.hash})`);
  logger.warn(
    `[PersistentSweep] MANUAL RECOVERY ${ethers.formatUnits(amt, BEP20_DECIMALS)} ${doc.address} → ${destination} tx=${tx.hash}`
  );
  return { txHash: tx.hash, amount: Number(ethers.formatUnits(amt, BEP20_DECIMALS)) };
}