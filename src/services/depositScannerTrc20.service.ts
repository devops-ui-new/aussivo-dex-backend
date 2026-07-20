/**
 * depositScannerTrc20.service.ts — exact TRC-20 deposit detection via TronGrid history.
 *
 * Tron has no address-set log filter equivalent to eth_getLogs, so we poll each
 * address's TRC-20 transfer history. To stay well inside TronGrid's rate limits we
 * poll in TIERS:
 *
 *   HOT   — user opened a deposit QR in the last 2h, or funds moved in the last 2h
 *           → every tick (15s). This is the "user is watching the modal" case.
 *   WARM  — any activity in the last 30 days → every ~5 minutes.
 *   COLD  — everything else → every ~60 minutes.
 *
 * Every tier is a genuine safety net: an address is NEVER stopped being watched, so
 * a deposit sent days after the QR closed is still found and credited. That is the
 * single biggest fund-loss hole in the previous design and it is closed here.
 *
 * Per-address cursor is `lastScannedTimestampMs`, and we always re-query with a small
 * overlap. Re-reading a transfer is free because deposit_credits deduplicates on
 * (network, txHash, logIndex).
 */
import { TronWeb } from "tronweb";
import {
  TRON_FULL_HOST,
  TRON_API_KEY,
  TRON_USDT_CONTRACT,
  TRON_USDT_DECIMALS,
  DEPOSIT_SCAN_INTERVAL_MS,
  PERSISTENT_DEPOSIT_ADDRESSES,
  TRON_SCAN_OVERLAP_MS,
} from "../configs/constants";
import DepositAddressModel from "../models/depositAddress.model";
import logger from "../configs/logger.config";
import { applyCredit, retryPendingCredits } from "./depositAddress.service";

const UNIT = 10 ** TRON_USDT_DECIMALS;
const HOT_MS = 2 * 60 * 60 * 1000;
const WARM_MS = 30 * 24 * 60 * 60 * 1000;
const WARM_INTERVAL_MS = 5 * 60 * 1000;
const COLD_INTERVAL_MS = 60 * 60 * 1000;
const PER_ADDRESS_DELAY_MS = 250; // gentle on TronGrid's per-second cap

let timer: NodeJS.Timeout | null = null;
let running = false;

function makeTronWeb(): TronWeb {
  const opts: any = { fullHost: TRON_FULL_HOST };
  if (TRON_API_KEY) opts.headers = { "TRON-PRO-API-KEY": TRON_API_KEY };
  return new TronWeb(opts);
}

/** Should this address be polled on this tick? */
function isDue(doc: any, now: number): boolean {
  const lastScan = doc.lastScanAt ? new Date(doc.lastScanAt).getTime() : 0;
  const lastActivity = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
  const activeVaultAt = doc.activeVaultSetAt ? new Date(doc.activeVaultSetAt).getTime() : 0;

  const hot = now - Math.max(lastActivity, activeVaultAt) < HOT_MS;
  if (hot) return true;

  const warm = now - lastActivity < WARM_MS;
  return now - lastScan >= (warm ? WARM_INTERVAL_MS : COLD_INTERVAL_MS);
}

/**
 * Fetch inbound TRC-20 USDT transfers for one address since its cursor.
 * `only_to=true` restricts to inbound, so outbound sweeps never appear here.
 */
async function fetchInbound(address: string, sinceMs: number): Promise<any[]> {
  const base = TRON_FULL_HOST.replace(/\/+$/, "");
  const params = new URLSearchParams({
    only_to: "true",
    limit: "200",
    order_by: "block_timestamp,asc",
    contract_address: TRON_USDT_CONTRACT,
    min_timestamp: String(Math.max(0, sinceMs)),
  });
  const url = `${base}/v1/accounts/${address}/transactions/trc20?${params}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (TRON_API_KEY) headers["TRON-PRO-API-KEY"] = TRON_API_KEY;

  const res = await fetch(url, { headers });
  if (res.status === 429) throw Object.assign(new Error("TronGrid rate limited"), { status: 429 });
  if (!res.ok) throw new Error(`TronGrid ${res.status}`);
  const body: any = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

async function scanOne(doc: any): Promise<void> {
  const address: string = doc.address;
  const since = Math.max(0, Number(doc.lastScannedTimestampMs || 0) - TRON_SCAN_OVERLAP_MS);

  let rows: any[];
  try {
    rows = await fetchInbound(address, since);
  } catch (e: any) {
    // A rate limit or transient error must NOT advance the cursor.
    if (e?.status !== 429) {
      logger.warn(`[ScanTRC20] history fetch failed for ${address}: ${e?.message || e}`);
    }
    return;
  }

  let maxTs = Number(doc.lastScannedTimestampMs || 0);
  // Several transfers can share a txid; index them so logIndex stays stable & unique.
  const perTxCounter = new Map<string, number>();

  for (const row of rows) {
    try {
      const txid: string = row?.transaction_id || "";
      if (!txid) continue;
      if (String(row?.to || "") !== address) continue; // paranoia: only_to should guarantee this
      if (String(row?.token_info?.address || "") !== TRON_USDT_CONTRACT) continue;

      const raw = String(row?.value ?? "0");
      const value = BigInt(raw);
      if (value <= 0n) continue;

      const idx = perTxCounter.get(txid) ?? 0;
      perTxCounter.set(txid, idx + 1);

      const ts = Number(row?.block_timestamp || 0);
      if (ts > maxTs) maxTs = ts;

      await applyCredit({
        network: "trc20",
        asset: "USDT",
        txHash: txid,
        logIndex: idx,
        fromAddress: String(row?.from || ""),
        toAddress: address,
        tokenAddress: TRON_USDT_CONTRACT,
        amountBaseUnits: value.toString(),
        amount: Number(value) / UNIT,
        decimals: TRON_USDT_DECIMALS,
        blockTimestampMs: ts,
      });
    } catch (e: any) {
      logger.error(`[ScanTRC20] row handling failed for ${address}: ${e?.message || e}`);
      // Do not advance past a row we failed to handle.
      return;
    }
  }

  await DepositAddressModel.findByIdAndUpdate(doc._id, {
    $set: {
      lastScanAt: new Date(),
      ...(maxTs > Number(doc.lastScannedTimestampMs || 0) ? { lastScannedTimestampMs: maxTs } : {}),
    },
  });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const all = await DepositAddressModel.find({ network: "trc20", status: "active" })
      .select("_id address lastScannedTimestampMs lastScanAt lastActivityAt activeVaultSetAt")
      .lean();

    const due = all.filter((d: any) => isDue(d, now));
    for (const doc of due) {
      await scanOne(doc);
      await new Promise((r) => setTimeout(r, PER_ADDRESS_DELAY_MS));
    }

    await retryPendingCredits(25);
  } catch (e: any) {
    logger.error(`[ScanTRC20] tick error: ${e?.message || e}`);
  } finally {
    running = false;
  }
}

export function startTrc20DepositScanner(): void {
  if (timer) return;
  if (!PERSISTENT_DEPOSIT_ADDRESSES) {
    logger.info("[ScanTRC20] disabled (PERSISTENT_DEPOSIT_ADDRESSES=false)");
    return;
  }
  logger.info(`[ScanTRC20] started — tiered polling every ${DEPOSIT_SCAN_INTERVAL_MS / 1000}s`);
  void tick();
  timer = setInterval(() => void tick(), DEPOSIT_SCAN_INTERVAL_MS);
}

export function stopTrc20DepositScanner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Admin/ops: force a full history re-read for one address (ignores the cursor). */
export async function rescanTrc20Address(addressId: string): Promise<void> {
  const doc = await DepositAddressModel.findById(addressId).lean();
  if (!doc) throw new Error("Deposit address not found");
  await scanOne({ ...doc, lastScannedTimestampMs: 0 });
}