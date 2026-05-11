import { ethers } from "ethers";
import {
  BSC_CHAIN_ID,
  BSC_PROVIDER_URL,
  EPHEMERAL_WALLET_SECRET,
  GAS_FUNDER_PRIVATE_KEY,
  TREASURY_WALLET_ADDRESS,
  getCanonicalBscStableDecimals,
  USDT_CONTRACT_ADDRESS,
  USDC_CONTRACT_ADDRESS,
} from "../configs/constants";
import { decryptPrivateKeyHex } from "../helpers/walletCrypto.helper";
import PendingDepositModel from "../models/pendingDeposit.model";
import DepositModel from "../models/deposit.model";
import UserModel from "../models/user.model";
import VaultModel from "../models/vault.model";
import ActivityModel from "../models/activity.model";
import { sendEmail } from "../configs/email.config";
import logger from "../configs/logger.config";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const GAS_TOPUP_WEI = 350_000_000_000_000n;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const processing = new Set<string>();

let provider: ethers.JsonRpcProvider | null = null;

function creditRecordTxHash(requestId: string): string {
  return `ephemeral-received:${requestId}`;
}

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(BSC_PROVIDER_URL, BSC_CHAIN_ID, { staticNetwork: true });
    provider.on("error", (err) => {
      logger.error(`[EphemeralSweep] RPC error: ${(err as Error)?.message || err}`);
    });
  }
  return provider;
}

export async function fundEphemeralGas(ephemeralAddress: string): Promise<string> {
  if (!GAS_FUNDER_PRIVATE_KEY || !ethers.isAddress(ephemeralAddress)) return "";
  try {
    const p = getProvider();
    const funder = new ethers.Wallet(GAS_FUNDER_PRIVATE_KEY, p);
    const tx = await funder.sendTransaction({ to: ephemeralAddress, value: GAS_TOPUP_WEI });
    await tx.wait(1);
    logger.info(`[EphemeralSweep] Gas funded ${ephemeralAddress} tx=${tx.hash}`);
    return tx.hash;
  } catch (e: any) {
    logger.warn(`[EphemeralSweep] Gas fund failed for ${ephemeralAddress}: ${e?.message || e}`);
    return "";
  }
}

function tokenAddressForAsset(asset: string): string {
  if (asset === "USDC") return USDC_CONTRACT_ADDRESS;
  return USDT_CONTRACT_ADDRESS;
}

function normalizeAddr(addr: string): string {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    return "";
  }
}

function topicAddress(addr: string): string {
  return `0x000000000000000000000000${addr.toLowerCase().replace(/^0x/, "")}`;
}

async function blockAtOrAfterTimestamp(tsSec: number): Promise<number> {
  const p = getProvider();
  const latest = await p.getBlock("latest");
  if (!latest) return 0;
  let lo = 1;
  let hi = latest.number;
  let ans = latest.number;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await p.getBlock(mid);
    if (!b) break;
    if (b.timestamp >= tsSec) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

async function findDepositorAddressesForWindow(params: {
  tokenAddress: string;
  ephemeralAddress: string;
  fromMs: number;
  toMs: number;
}): Promise<string[]> {
  const p = getProvider();
  const toNorm = normalizeAddr(params.ephemeralAddress);
  if (!toNorm) return [];

  const fromBlock = await blockAtOrAfterTimestamp(Math.max(0, Math.floor(params.fromMs / 1000)));
  const toBlock = await blockAtOrAfterTimestamp(Math.max(0, Math.floor(params.toMs / 1000)));
  if (toBlock < fromBlock) return [];

  const logs = await p.getLogs({
    address: params.tokenAddress,
    topics: [TRANSFER_TOPIC, null, topicAddress(toNorm)],
    fromBlock,
    toBlock,
  });
  const seen = new Set<string>();
  for (const log of logs) {
    const fromTopic = log.topics?.[1];
    if (!fromTopic || fromTopic.length !== 66) continue;
    const fromHex = `0x${fromTopic.slice(26)}`;
    const fromNorm = normalizeAddr(fromHex);
    if (fromNorm) seen.add(fromNorm);
  }
  return [...seen];
}

/**
 * Credit user + vault as soon as USDT is on the ephemeral address (before treasury sweep).
 * Idempotent via unique `pendingRequestId` on deposits.
 */
async function applyDepositAccounting(
  pending: { _id: any; userId: any; vaultId: any; expectedAmount: number; asset: string; requestId: string; ephemeralAddress?: string },
  opts?: { settledAmount?: number; depositorAddresses?: string[] }
): Promise<void> {
  const dup = await DepositModel.findOne({ pendingRequestId: pending.requestId });
  if (dup) return;

  const user = await UserModel.findById(pending.userId);
  if (!user) {
    throw new Error(`No user ${pending.userId}`);
  }
  const vault = await VaultModel.findById(pending.vaultId);
  if (!vault) {
    throw new Error(`No vault ${pending.vaultId}`);
  }

  const amount = Number(opts?.settledAmount ?? pending.expectedAmount);
  const symbol = pending.asset;
  const depositorAddresses = (opts?.depositorAddresses || []).map((a) => normalizeAddr(a)).filter(Boolean);

  let tierIndex = 0;
  let apyPercent = vault.tiers[0]?.apyPercent || 0;
  for (let i = vault.tiers.length - 1; i >= 0; i--) {
    if (amount >= vault.tiers[i].minAmount) {
      tierIndex = i;
      apyPercent = vault.tiers[i].apyPercent;
      break;
    }
  }

  const lockUntil = vault.lockDays > 0 ? new Date(Date.now() + vault.lockDays * 86400000) : null;
  const recordHash = creditRecordTxHash(pending.requestId);

  let deposit;
  try {
    deposit = await DepositModel.create({
      userId: user._id,
      vaultId: vault._id,
      amount,
      asset: symbol,
      txHash: recordHash,
      pendingRequestId: pending.requestId,
      walletAddress: depositorAddresses[0] || String(pending.ephemeralAddress || "").toLowerCase(),
      depositorAddresses,
      lockUntil,
      apyPercent,
      tierIndex,
      maxYieldPayments: vault.durationMonths,
      status: "active",
    });
  } catch (e: any) {
    if (e?.code === 11000) return;
    throw e;
  }

  await VaultModel.findByIdAndUpdate(vault._id, {
    $inc: { totalStaked: amount, totalUsers: 1 },
  });

  const balField = symbol === "USDT" ? "usdtBalance" : "usdcBalance";
  await UserModel.findByIdAndUpdate(user._id, {
    $inc: { [balField]: amount, totalDeposited: amount },
  });

  if (depositorAddresses.length) {
    const known = (user.walletAddresses || []).map((w: string) => normalizeAddr(w)).filter(Boolean);
    const uniqueIncoming = depositorAddresses.filter((a) => !known.includes(a));
    if (uniqueIncoming.length) {
      const available: string[] = [];
      for (const addr of uniqueIncoming) {
        const conflict = await UserModel.findOne({
          _id: { $ne: user._id },
          $or: [{ walletAddress: addr }, { walletAddresses: addr }],
        }).select("_id");
        if (!conflict) available.push(addr);
      }
      if (available.length) {
        await UserModel.findByIdAndUpdate(user._id, {
          $addToSet: { walletAddresses: { $each: available } },
          ...(user.walletAddress ? {} : { $set: { walletAddress: available[0] } }),
        });
      }
    }
  }

  await ActivityModel.create({
    userId: user._id,
    title: "Deposit Confirmed",
    description: `$${amount} ${symbol} received on one-time address; treasury sweep follows.`,
    type: "deposit",
    metadata: {
      vaultId: vault._id,
      depositId: deposit._id,
      amount,
      txHash: recordHash,
      pendingRequestId: pending.requestId,
      depositorAddresses,
    },
  });

  const monthlyYield = ((amount * apyPercent) / 100).toFixed(2);
  try {
    await sendEmail(user.email, "✅ Deposit Confirmed — Aussivo.DEX", "deposit-confirmation", {
      name: user.name,
      amount: amount.toFixed(2),
      asset: symbol,
      vaultName: vault.name,
      apyPercent: apyPercent.toFixed(1),
      monthlyYield,
      lockDays: vault.lockDays,
      txHash: recordHash,
      txHashShort: "Sweep pending — check Portfolio",
      date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    });
  } catch (e: any) {
    logger.warn(`[EphemeralSweep] Email failed: ${e?.message}`);
  }

  logger.info(`[EphemeralSweep] Credited user ${user.email} ${amount} ${symbol} (requestId=${pending.requestId.slice(0, 10)}…)`);
}

async function sweepOne(pendingArg: any): Promise<void> {
  const id = String(pendingArg._id);
  if (processing.has(id)) return;
  processing.add(id);

  try {
    const doc = await PendingDepositModel.findById(pendingArg._id).lean();
    if (!doc || doc.status === "matched" || doc.status === "expired") return;

    const tokenAddr = tokenAddressForAsset(doc.asset);
    const p = getProvider();
    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, p);
    const ephemeral = String(doc.ephemeralAddress).toLowerCase();
    let bal: bigint = await erc20.balanceOf(ephemeral);
    const expected = BigInt(String(doc.expectedAmountBaseUnits || "0"));
    const nowMs = Date.now();
    const expiresMs = new Date(doc.expiresAt).getTime();
    const isWindowOpen = nowMs < expiresMs;

    if (isWindowOpen) {
      if (bal > 0n) {
        logger.info(
          `[EphemeralSweep] Tracking ${ephemeral}: currentBalance=${bal.toString()} expected=${expected.toString()} until=${new Date(expiresMs).toISOString()}`
        );
      }
      return;
    }

    if (bal === 0n) {
      if (doc.status === "pending" && !doc.userCreditedAt && !doc.sweepTxHash) {
        await PendingDepositModel.findByIdAndUpdate(doc._id, { status: "expired" });
        logger.info(`[EphemeralSweep] Expired empty intent ${doc.requestId}`);
      }
      return;
    }

    const decimals = getCanonicalBscStableDecimals(tokenAddr) ?? 18;
    const settledAmount = Number(ethers.formatUnits(bal, decimals));
    const depositorAddresses = await findDepositorAddressesForWindow({
      tokenAddress: tokenAddr,
      ephemeralAddress: ephemeral,
      fromMs: Math.max(0, new Date(doc.createdAt).getTime() - 60_000),
      toMs: expiresMs + 60_000,
    });

    if (!doc.userCreditedAt) {
      const transitioned = await PendingDepositModel.findOneAndUpdate(
        { _id: doc._id, userCreditedAt: null, status: "pending" },
        {
          $set: {
            userCreditedAt: new Date(),
            status: "credited",
            expectedAmount: settledAmount,
            expectedAmountBaseUnits: bal.toString(),
            receivedAmount: settledAmount,
            receivedAmountBaseUnits: bal.toString(),
            depositorAddresses,
          },
        },
        { new: true }
      );
      if (transitioned) {
        try {
          await applyDepositAccounting(doc as any, {
            settledAmount,
            depositorAddresses,
          });
        } catch (err: any) {
          logger.error(`[EphemeralSweep] Credit accounting failed ${doc._id}: ${err?.message || err}`);
          await PendingDepositModel.findByIdAndUpdate(doc._id, {
            $set: { status: "pending", userCreditedAt: null },
          });
          return;
        }
      }
    } else if (depositorAddresses.length) {
      await PendingDepositModel.findByIdAndUpdate(doc._id, {
        $set: { receivedAmount: settledAmount, receivedAmountBaseUnits: bal.toString() },
        $addToSet: { depositorAddresses: { $each: depositorAddresses } },
      });
      await DepositModel.findOneAndUpdate(
        { pendingRequestId: doc.requestId },
        {
          $set: { amount: settledAmount },
          $addToSet: { depositorAddresses: { $each: depositorAddresses } },
        }
      );
    }

    const latest = await PendingDepositModel.findById(doc._id).lean();
    if (!latest?.privateKeyEncrypted) {
      return;
    }

    if (!TREASURY_WALLET_ADDRESS || !ethers.isAddress(TREASURY_WALLET_ADDRESS)) {
      logger.error(
        `[EphemeralSweep] TREASURY_WALLET_ADDRESS missing — user already credited; holding encrypted key for ${ephemeral} until treasury is configured.`
      );
      return;
    }

    let pk: string;
    try {
      pk = decryptPrivateKeyHex(latest.privateKeyEncrypted, EPHEMERAL_WALLET_SECRET);
    } catch (e: any) {
      logger.error(`[EphemeralSweep] Decrypt failed for ${latest._id}: ${e?.message}`);
      return;
    }

    const wallet = new ethers.Wallet(pk, p);
    if (wallet.address.toLowerCase() !== ephemeral) {
      logger.error(`[EphemeralSweep] Key/address mismatch for ${latest._id}`);
      return;
    }

    const erc20Write = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    let bnbBal = await p.getBalance(ephemeral);
    if (bnbBal < 80_000_000_000_000n) {
      logger.warn(`[EphemeralSweep] Low BNB on ${ephemeral} (${bnbBal.toString()} wei) — attempting gas top-up`);
      await fundEphemeralGas(ephemeral);
      bnbBal = await p.getBalance(ephemeral);
    }
    if (bnbBal < 30_000_000_000_000n) {
      logger.warn(
        `[EphemeralSweep] Cannot sweep yet ${ephemeral}: insufficient BNB for gas. Encrypted key retained; will retry. Set GAS_FUNDER_PRIVATE_KEY or fund BNB on this address.`
      );
      return;
    }

    bal = await erc20.balanceOf(ephemeral);
    if (bal === 0n) {
      return;
    }

    logger.info(
      `[EphemeralSweep] Sweeping ${bal.toString()} wei ${latest.asset} from ${ephemeral} → treasury (settled=${bal.toString()})`
    );

    const tx = await erc20Write.transfer(TREASURY_WALLET_ADDRESS, bal, { gasLimit: 150_000n });
    const receipt = await tx.wait(1);
    if (receipt?.status === 0) {
      logger.error(`[EphemeralSweep] Sweep tx reverted: ${tx.hash}`);
      return;
    }
    const sweepTxHash = receipt?.hash || tx.hash;

    const collision = await DepositModel.findOne({ txHash: sweepTxHash });
    if (collision && collision.pendingRequestId !== latest.requestId) {
      logger.warn(`[EphemeralSweep] Sweep hash collision ${sweepTxHash}`);
    }

    await DepositModel.findOneAndUpdate(
      { pendingRequestId: latest.requestId },
      { $set: { txHash: sweepTxHash } }
    );

    await PendingDepositModel.findByIdAndUpdate(latest._id, {
      $set: {
        status: "matched",
        sweepTxHash,
        matchedTxHash: sweepTxHash,
        matchedAt: new Date(),
        keyPurgedAt: new Date(),
      },
      $unset: { privateKeyEncrypted: "" },
    });

    logger.info(`[EphemeralSweep] Swept + purged key material for ${ephemeral} tx=${sweepTxHash}`);
  } catch (err: any) {
    logger.error(`[EphemeralSweep] Error processing ${pendingArg._id}: ${err?.message || err}`);
  } finally {
    processing.delete(id);
  }
}

async function tick() {
  try {
    const pendings = await PendingDepositModel.find({
      status: { $in: ["pending", "credited"] },
      ephemeralAddress: { $exists: true, $nin: [null, ""] },
    })
      .limit(50)
      .lean();
    for (const doc of pendings) {
      await sweepOne(doc);
    }
  } catch (e: any) {
    logger.error(`[EphemeralSweep] tick: ${e?.message || e}`);
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startEphemeralDepositSweep() {
  if (intervalId) return;
  if (TREASURY_WALLET_ADDRESS) {
    logger.info(`[EphemeralSweep] Treasury loaded ${TREASURY_WALLET_ADDRESS.slice(0, 8)}…${TREASURY_WALLET_ADDRESS.slice(-4)}`);
  } else {
    logger.warn(
      "[EphemeralSweep] Treasury address missing — users can still be credited; sweeps wait until TREASURY_WALLET_ADDRESS is set."
    );
  }
  logger.info("[EphemeralSweep] Starting interval (every 15s)");
  void tick();
  intervalId = setInterval(tick, 15_000);
}

export function stopEphemeralDepositSweep() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
