/**
 * depositScannerBep20.service.ts — exact, event-driven BSC deposit detection.
 *
 * WHY THIS REPLACES BALANCE POLLING
 * The old flow called `balanceOf()` and treated the result as "the deposit". That is
 * ambiguous by construction: it cannot distinguish one $5,000 transfer from two of
 * $2,500, it races the sweep, and it silently loses anything that arrives after the
 * intent expires. Here we read `Transfer` logs, so every deposit is an exact,
 * individually-identified event with a txHash the user can verify on BscScan.
 *
 * HOW IT SCALES
 * One `eth_getLogs` call per token per block range covers EVERY user's address at
 * once, because the recipient is an indexed topic and topic filters accept an OR-set.
 * Cost is O(blocks), not O(users). The address set is chunked only to stay under
 * per-RPC topic-array limits.
 *
 * SAFETY
 *  • CONFIRMATIONS lag protects against reorgs.
 *  • The cursor advances only when every chunk of a range succeeded. A partial failure
 *    simply re-scans; deposit_credits' unique index makes that a no-op.
 *  • Nothing here moves funds. Detection and sweeping are fully decoupled.
 */
import { ethers } from "ethers";
import {
  BSC_CHAIN_ID,
  BSC_PROVIDER_URL,
  USDT_CONTRACT_ADDRESS,
  USDC_CONTRACT_ADDRESS,
  DEPOSIT_SCAN_CONFIRMATIONS,
  DEPOSIT_SCAN_MAX_SPAN,
  DEPOSIT_SCAN_CHUNK_BLOCKS,
  DEPOSIT_SCAN_ADDRESS_CHUNK,
  DEPOSIT_SCAN_INTERVAL_MS,
  PERSISTENT_DEPOSIT_ADDRESSES,
} from "../configs/constants";
import ScannerStateModel from "../models/scannerState.model";
import logger from "../configs/logger.config";
import { applyCredit, listActiveAddresses, retryPendingCredits } from "./depositAddress.service";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/** BSC USDT and USDC are both 18-decimal. Verified on-chain if an unknown token appears. */
const KNOWN_DECIMALS: Record<string, number> = {
  "0x55d398326f99059ff775485246999027b3197955": 18, // mainnet USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 18, // mainnet USDC
  "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd": 18, // testnet USDT
  "0x64544969ed7ebf5f083679233325356ebe738930": 18, // testnet USDC
};

const decimalsCache = new Map<string, number>();
let providers: ethers.JsonRpcProvider[] | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

function getProviders(): ethers.JsonRpcProvider[] {
  if (!providers) {
    const urls = BSC_PROVIDER_URL.split(",").map((s) => s.trim()).filter(Boolean);
    const list = urls.length ? urls : ["https://bsc-dataseed1.binance.org"];
    providers = list.map((u) => new ethers.JsonRpcProvider(u, BSC_CHAIN_ID, { staticNetwork: true }));
  }
  return providers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** getLogs with endpoint fallback, retry, and recursive range-splitting. Throws only if all fail. */
async function getLogsResilient(
  filter: { address: string; topics: (string | string[] | null)[] },
  fromBlock: number,
  toBlock: number,
  depth = 0
): Promise<ethers.Log[]> {
  let lastErr: any;
  for (const prov of getProviders()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await prov.getLogs({ ...filter, fromBlock, toBlock } as any);
      } catch (e: any) {
        lastErr = e;
        await sleep(150 * (attempt + 1));
      }
    }
  }
  if (toBlock > fromBlock && depth < 14) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const [l, r] = await Promise.all([
      getLogsResilient(filter, fromBlock, mid, depth + 1),
      getLogsResilient(filter, mid + 1, toBlock, depth + 1),
    ]);
    return [...l, ...r];
  }
  throw lastErr;
}

async function tokenDecimals(tokenAddr: string): Promise<number> {
  const k = tokenAddr.toLowerCase();
  if (KNOWN_DECIMALS[k] != null) return KNOWN_DECIMALS[k];
  if (decimalsCache.has(k)) return decimalsCache.get(k)!;
  try {
    const c = new ethers.Contract(tokenAddr, ["function decimals() view returns (uint8)"], getProviders()[0]);
    const d = Number(await c.decimals());
    decimalsCache.set(k, d);
    return d;
  } catch {
    decimalsCache.set(k, 18);
    return 18;
  }
}

function topicForAddress(addr: string): string {
  return `0x000000000000000000000000${addr.toLowerCase().replace(/^0x/, "")}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface TokenSpec {
  address: string;
  asset: "USDT" | "USDC";
}

function tokensToScan(): TokenSpec[] {
  const out: TokenSpec[] = [];
  if (USDT_CONTRACT_ADDRESS && ethers.isAddress(USDT_CONTRACT_ADDRESS)) {
    out.push({ address: ethers.getAddress(USDT_CONTRACT_ADDRESS), asset: "USDT" });
  }
  if (USDC_CONTRACT_ADDRESS && ethers.isAddress(USDC_CONTRACT_ADDRESS)) {
    out.push({ address: ethers.getAddress(USDC_CONTRACT_ADDRESS), asset: "USDC" });
  }
  return out;
}

async function getCursor(key: string, headBlock: number): Promise<number> {
  const doc = await ScannerStateModel.findOne({ key });
  if (doc && doc.lastScannedBlock > 0) return doc.lastScannedBlock;
  // First run: start from the safe head rather than genesis. The migration script
  // backfills history for pre-existing addresses separately.
  const start = Math.max(1, headBlock - DEPOSIT_SCAN_CONFIRMATIONS);
  await ScannerStateModel.findOneAndUpdate(
    { key },
    { $set: { lastScannedBlock: start, headBlock } },
    { upsert: true }
  );
  logger.info(`[ScanBEP20] Initialised cursor ${key} at block ${start}`);
  return start;
}

async function scanToken(token: TokenSpec, addressTopics: string[], head: number): Promise<void> {
  const key = `bep20:${token.address.toLowerCase()}`;
  const cursor = await getCursor(key, head);
  const safeHead = head - DEPOSIT_SCAN_CONFIRMATIONS;
  if (safeHead <= cursor) {
    logger.info(`[ScanBEP20] ${token.asset} up to date at block ${cursor} (head ${head})`);
    return;
  }

  const from = cursor + 1;
  const to = Math.min(safeHead, from + DEPOSIT_SCAN_MAX_SPAN - 1);
  const decimals = await tokenDecimals(token.address);
  const addrChunks = chunk(addressTopics, DEPOSIT_SCAN_ADDRESS_CHUNK);

  let allOk = true;
  let found = 0;
  logger.info(
    `[ScanBEP20] ${token.asset} scanning ${from}→${to} (${to - from + 1} blocks, ${addressTopics.length} address(es), ${safeHead - to} behind)`
  );

  for (let start = from; start <= to; start += DEPOSIT_SCAN_CHUNK_BLOCKS) {
    const end = Math.min(start + DEPOSIT_SCAN_CHUNK_BLOCKS - 1, to);
    for (const group of addrChunks) {
      try {
        const logs = await getLogsResilient(
          { address: token.address, topics: [TRANSFER_TOPIC, null, group] },
          start,
          end
        );
        for (const log of logs) {
          try {
            const toTopic = log.topics?.[2];
            const fromTopic = log.topics?.[1];
            if (!toTopic) continue;
            const toAddr = ethers.getAddress(`0x${toTopic.slice(26)}`);
            const fromAddr = fromTopic ? ethers.getAddress(`0x${fromTopic.slice(26)}`) : "";
            const value = BigInt(log.data);
            if (value <= 0n) continue;

            found++;
            await applyCredit({
              network: "bep20",
              asset: token.asset,
              txHash: log.transactionHash,
              logIndex: Number(log.index),
              fromAddress: fromAddr.toLowerCase(),
              toAddress: toAddr.toLowerCase(),
              tokenAddress: token.address.toLowerCase(),
              amountBaseUnits: value.toString(),
              amount: Number(ethers.formatUnits(value, decimals)),
              decimals,
              blockNumber: log.blockNumber,
            });
          } catch (e: any) {
            // One bad log must never stall the range. The credit row (if claimed)
            // is retried by retryPendingCredits().
            allOk = false;
            logger.error(`[ScanBEP20] log handling failed tx=${log.transactionHash}: ${e?.message || e}`);
          }
        }
      } catch (e: any) {
        allOk = false;
        logger.warn(`[ScanBEP20] getLogs ${start}-${end} failed: ${e?.shortMessage || e?.message || e}`);
      }
    }
  }

  // Advance ONLY on a clean pass. Re-scanning is free (unique index dedupes),
  // skipping a range is not — it would lose a deposit permanently.
  if (allOk) {
    await ScannerStateModel.findOneAndUpdate(
      { key },
      { $set: { lastScannedBlock: to, headBlock: head, lastRunAt: new Date(), lastError: "" } },
      { upsert: true }
    );
    logger.info(
      `[ScanBEP20] ${token.asset} ok ${from}→${to} · ${found} transfer(s) to our addresses · cursor now ${to}` +
        (safeHead > to ? ` · ${safeHead - to} blocks still to catch up` : " · caught up")
    );
  } else {
    await ScannerStateModel.findOneAndUpdate(
      { key },
      { $set: { headBlock: head, lastRunAt: new Date(), lastError: `partial failure in ${from}-${to}` } },
      { upsert: true }
    );
    logger.warn(`[ScanBEP20] Range ${from}-${to} incomplete — cursor held at ${cursor}, will retry`);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const addresses = await listActiveAddresses("bep20");
    if (!addresses.length) {
      logger.info("[ScanBEP20] no active BSC deposit addresses yet — nothing to scan");
      return;
    }

    let head: number;
    try {
      head = await getProviders()[0].getBlockNumber();
    } catch (e: any) {
      logger.error(
        `[ScanBEP20] cannot reach RPC (${BSC_PROVIDER_URL.split(",")[0]}): ${e?.shortMessage || e?.message || e}`
      );
      return;
    }
    const topics = addresses.map((a: any) => topicForAddress(a.addressLookup));

    for (const token of tokensToScan()) {
      await scanToken(token, topics, head);
    }

    await retryPendingCredits(25);
  } catch (e: any) {
    logger.error(`[ScanBEP20] tick error: ${e?.message || e}`);
  } finally {
    running = false;
  }
}

export function startBep20DepositScanner(): void {
  if (timer) return;
  if (!PERSISTENT_DEPOSIT_ADDRESSES) {
    logger.info("[ScanBEP20] disabled (PERSISTENT_DEPOSIT_ADDRESSES=false)");
    return;
  }
  logger.info(
    `[ScanBEP20] started — every ${DEPOSIT_SCAN_INTERVAL_MS / 1000}s, ${DEPOSIT_SCAN_CONFIRMATIONS} confirmations`
  );
  void tick();
  timer = setInterval(() => void tick(), DEPOSIT_SCAN_INTERVAL_MS);
}

export function stopBep20DepositScanner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Admin/ops: re-scan an explicit block range. Idempotent — safe to run any time. */
export async function rescanBep20Range(fromBlock: number, toBlock: number): Promise<void> {
  const addresses = await listActiveAddresses("bep20");
  if (!addresses.length) return;
  const topics = addresses.map((a: any) => topicForAddress(a.addressLookup));
  const groups = chunk(topics, DEPOSIT_SCAN_ADDRESS_CHUNK);

  for (const token of tokensToScan()) {
    const decimals = await tokenDecimals(token.address);
    for (let start = fromBlock; start <= toBlock; start += DEPOSIT_SCAN_CHUNK_BLOCKS) {
      const end = Math.min(start + DEPOSIT_SCAN_CHUNK_BLOCKS - 1, toBlock);
      for (const group of groups) {
        const logs = await getLogsResilient(
          { address: token.address, topics: [TRANSFER_TOPIC, null, group] },
          start,
          end
        );
        for (const log of logs) {
          const toTopic = log.topics?.[2];
          const fromTopic = log.topics?.[1];
          if (!toTopic) continue;
          const value = BigInt(log.data);
          if (value <= 0n) continue;
          await applyCredit({
            network: "bep20",
            asset: token.asset,
            txHash: log.transactionHash,
            logIndex: Number(log.index),
            fromAddress: fromTopic ? ethers.getAddress(`0x${fromTopic.slice(26)}`).toLowerCase() : "",
            toAddress: ethers.getAddress(`0x${toTopic.slice(26)}`).toLowerCase(),
            tokenAddress: token.address.toLowerCase(),
            amountBaseUnits: value.toString(),
            amount: Number(ethers.formatUnits(value, decimals)),
            decimals,
            blockNumber: log.blockNumber,
          });
        }
      }
    }
  }
  logger.info(`[ScanBEP20] Manual rescan complete for ${fromBlock}-${toBlock}`);
}