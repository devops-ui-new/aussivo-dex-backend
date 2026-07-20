/**
 * depositAddress.service.ts — the heart of the persistent-address deposit flow.
 *
 * Responsibilities:
 *   1. getOrCreateDepositAddress()  — one permanent address per (user, network)
 *   2. setActiveVault()             — remember which vault the next inflow belongs to
 *   3. applyCredit()                — turn ONE on-chain transfer into ONE booked deposit
 *
 * Design notes that matter:
 *
 *  • applyCredit() delegates the actual accounting to the EXISTING
 *    applyDepositAccounting() in ephemeralDepositSweep.service.ts. That function
 *    already creates the deposit row, bumps user balance + vault TVL, links depositor
 *    wallets, fires the registry/mirror/attest side effects and sends the confirmation
 *    email — and it is idempotent via the unique `deposits.pendingRequestId` index.
 *    Reusing it means the new flow and the legacy flow can NEVER diverge in accounting.
 *
 *  • Vault attribution never fails. Resolution order:
 *        open pending_deposits intent → address.activeVaultId
 *        → last credited vault → user's most recent deposit's vault
 *        → first active vault matching the asset
 *    A transfer is credited even if the user never opened a QR at all.
 *
 *  • Nothing here ever throws into the scanner loop for a recoverable reason. A credit
 *    that cannot be booked stays `detected` and is retried; the money is on an address
 *    whose key is permanently recoverable.
 */
import { Types } from "mongoose";
import DepositAddressModel from "../models/depositAddress.model";
import DepositCreditModel from "../models/depositCredit.model";
import PendingDepositModel from "../models/pendingDeposit.model";
import DepositModel from "../models/deposit.model";
import VaultModel from "../models/vault.model";
import UserModel from "../models/user.model";
import ScannerStateModel from "../models/scannerState.model";
import ActivityModel from "../models/activity.model";
import logger from "../configs/logger.config";
import { DEPOSIT_KEY_BACKUP } from "../configs/constants";
import {
  createDepositKey,
  normalizeDepositAddress,
  DepositNetwork,
} from "../helpers/depositKey.helper";
import { applyDepositAccounting } from "./ephemeralDepositSweep.service";

const MAX_CREDIT_ATTEMPTS = 10;

/** Atomic, race-free HD index allocation. */
async function nextHdIndex(network: DepositNetwork): Promise<number> {
  const doc = await ScannerStateModel.findOneAndUpdate(
    { key: `hd-index:${network}` },
    { $inc: { counter: 1 } },
    { upsert: true, new: true }
  );
  return Number(doc?.counter ?? 1);
}

/**
 * Return the user's permanent deposit address for a chain, creating it once.
 *
 * Safe to call on every QR open. Concurrent calls converge on the same address:
 * the unique {userId, network} index turns a race into an E11000 that we resolve
 * by simply re-reading the winner's document.
 */
export async function getOrCreateDepositAddress(
  userId: string | Types.ObjectId,
  network: DepositNetwork
): Promise<any> {
  const existing = await DepositAddressModel.findOne({ userId, network, status: "active" });
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    const index = await nextHdIndex(network);
    const key = createDepositKey(network, index, DEPOSIT_KEY_BACKUP);
    try {
      const created = await DepositAddressModel.create({
        userId,
        network,
        address: key.address,
        addressLookup: key.addressLookup,
        keySource: key.keySource,
        derivationIndex: key.derivationIndex,
        derivationPath: key.derivationPath || "",
        privateKeyEncrypted: key.privateKeyEncrypted,
        privateKeyHash: key.privateKeyHash,
        status: "active",
      });
      logger.info(
        `[DepositAddress] Created ${network} address ${key.address} for user ${userId} ` +
          `(custody=${key.keySource}${key.derivationPath ? ` path=${key.derivationPath}` : ""})`
      );
      return created;
    } catch (e: any) {
      if (e?.code === 11000) {
        // Either another request created this user's address first, or (vanishingly
        // unlikely) an index collision. Re-read; if the user now has one, use it.
        const winner = await DepositAddressModel.findOne({ userId, network, status: "active" });
        if (winner) return winner;
        continue; // index collision — allocate a fresh one
      }
      throw e;
    }
  }
  throw new Error(`Could not allocate a ${network} deposit address for user ${userId}`);
}

/** Record which vault the user is currently depositing into. */
export async function setActiveVault(
  addressId: Types.ObjectId | string,
  vaultId: Types.ObjectId | string
): Promise<void> {
  await DepositAddressModel.findByIdAndUpdate(addressId, {
    $set: { activeVaultId: vaultId, activeVaultSetAt: new Date() },
  });
}

/** Map an on-chain address back to its owner. Used by both scanners. */
export async function findAddressByOnChain(
  network: DepositNetwork,
  address: string
): Promise<any | null> {
  return DepositAddressModel.findOne({
    network,
    addressLookup: normalizeDepositAddress(network, address),
  });
}

/** Every active address on a chain — the scanner's watch list. */
export async function listActiveAddresses(network: DepositNetwork): Promise<any[]> {
  return DepositAddressModel.find({ network, status: "active" })
    .select("_id userId address addressLookup lastScannedTimestampMs lastActivityAt activeVaultSetAt")
    .lean();
}

/**
 * Decide which vault an inbound transfer belongs to. Never returns null unless the
 * platform genuinely has no active vault for that asset.
 */
async function resolveVaultForCredit(
  addrDoc: any,
  asset: string
): Promise<{ vaultId: Types.ObjectId | null; pendingDepositId: Types.ObjectId | null }> {
  // 1. An open deposit session the user started — the strongest signal of intent.
  const intent = await PendingDepositModel.findOne({
    userId: addrDoc.userId,
    network: addrDoc.network,
    depositAddressId: addrDoc._id,
    status: "pending",
  })
    .sort({ createdAt: -1 })
    .lean();
  if (intent?.vaultId) {
    const v = await VaultModel.findById(intent.vaultId).select("_id asset status");
    if (v && v.asset === asset) {
      return { vaultId: v._id as any, pendingDepositId: intent._id as any };
    }
  }

  // 2. Last vault the user opened a QR for.
  if (addrDoc.activeVaultId) {
    const v = await VaultModel.findById(addrDoc.activeVaultId).select("_id asset status");
    if (v && v.asset === asset && v.status === "active") {
      return { vaultId: v._id as any, pendingDepositId: (intent?._id as any) || null };
    }
  }

  // 3. Last vault we actually credited for this address.
  if (addrDoc.lastCreditedVaultId) {
    const v = await VaultModel.findById(addrDoc.lastCreditedVaultId).select("_id asset status");
    if (v && v.asset === asset && v.status === "active") {
      return { vaultId: v._id as any, pendingDepositId: null };
    }
  }

  // 4. The user's most recent deposit of this asset.
  const lastDep = await DepositModel.findOne({ userId: addrDoc.userId, asset })
    .sort({ createdAt: -1 })
    .select("vaultId")
    .lean();
  if (lastDep?.vaultId) {
    const v = await VaultModel.findById(lastDep.vaultId).select("_id asset status");
    if (v && v.asset === asset && v.status === "active") {
      return { vaultId: v._id as any, pendingDepositId: null };
    }
  }

  // 5. Last resort — any active vault for this asset. Money is never dropped.
  const fallback = await VaultModel.findOne({ asset, status: "active" })
    .sort({ createdAt: 1 })
    .select("_id");
  return { vaultId: (fallback?._id as any) || null, pendingDepositId: null };
}

export interface IncomingTransfer {
  network: DepositNetwork;
  asset: "USDT" | "USDC";
  txHash: string;
  logIndex: number;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  amountBaseUnits: string;
  amount: number;
  decimals: number;
  blockNumber?: number;
  blockTimestampMs?: number;
}

/**
 * Book ONE inbound transfer.
 *
 * Step 1 claims the transfer by inserting a deposit_credits row. The unique
 * (network, txHash, logIndex) index means a duplicate is a silent no-op — this is
 * what makes re-scanning, retries and crash recovery safe.
 *
 * Step 2 applies accounting through the shared applyDepositAccounting(), which is
 * itself idempotent on `deposits.pendingRequestId`. Both layers must agree before
 * the credit is marked final.
 */
export async function applyCredit(transfer: IncomingTransfer): Promise<"credited" | "duplicate" | "deferred"> {
  const addrDoc = await findAddressByOnChain(transfer.network, transfer.toAddress);
  if (!addrDoc) return "duplicate"; // not one of ours — nothing to do

  const requestId = `xfer:${transfer.network}:${transfer.txHash}:${transfer.logIndex}`;

  // ── 1. Claim ──────────────────────────────────────────────────────────────
  let credit: any;
  try {
    credit = await DepositCreditModel.create({
      userId: addrDoc.userId,
      addressId: addrDoc._id,
      network: transfer.network,
      asset: transfer.asset,
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
      fromAddress: transfer.fromAddress || "",
      toAddress: transfer.toAddress,
      tokenAddress: transfer.tokenAddress || "",
      amountBaseUnits: transfer.amountBaseUnits,
      amount: transfer.amount,
      decimals: transfer.decimals,
      blockNumber: transfer.blockNumber || 0,
      blockTimestampMs: transfer.blockTimestampMs || 0,
      requestId,
      status: "detected",
    });
  } catch (e: any) {
    if (e?.code === 11000) return "duplicate"; // already seen — exactly what we want
    throw e;
  }

  return finalizeCredit(credit, addrDoc);
}

/**
 * Apply accounting for a claimed credit. Split out so the retry loop can re-run it
 * for rows stuck in `detected` without re-detecting anything on chain.
 */
export async function finalizeCredit(credit: any, addrDocMaybe?: any): Promise<"credited" | "deferred"> {
  const addrDoc = addrDocMaybe || (await DepositAddressModel.findById(credit.addressId));
  if (!addrDoc) return "deferred";

  try {
    const { vaultId, pendingDepositId } = await resolveVaultForCredit(addrDoc, credit.asset);
    if (!vaultId) {
      throw new Error(`No active ${credit.asset} vault to credit into`);
    }

    // Reuse the existing, battle-tested accounting path verbatim.
    await applyDepositAccounting(
      {
        _id: credit._id,
        userId: addrDoc.userId,
        vaultId,
        expectedAmount: credit.amount,
        asset: credit.asset,
        requestId: credit.requestId,
        ephemeralAddress: addrDoc.address,
      } as any,
      {
        settledAmount: credit.amount,
        depositorAddresses: credit.fromAddress ? [credit.fromAddress] : [],
        skipConfirmationEmail: false,
      }
    );

    const deposit = await DepositModel.findOne({ pendingRequestId: credit.requestId }).select("_id");

    await DepositCreditModel.findByIdAndUpdate(credit._id, {
      $set: {
        status: "credited",
        creditedAt: new Date(),
        vaultId,
        pendingDepositId,
        depositId: deposit?._id || null,
        lastError: "",
      },
    });

    // Running totals + activity marker for tiered scan scheduling.
    await DepositAddressModel.findByIdAndUpdate(addrDoc._id, {
      $inc: { creditedTotal: credit.amountBaseUnits as any, creditsCount: 1 },
      $set: {
        lastActivityAt: new Date(),
        lastCreditedVaultId: vaultId,
        unexplainedBalanceSince: null,
      },
    });

    // Resolve the user's open QR session so the frontend modal closes as it always has.
    if (pendingDepositId) {
      await PendingDepositModel.findOneAndUpdate(
        { _id: pendingDepositId, userCreditedAt: null },
        {
          $set: {
            status: "credited",
            userCreditedAt: new Date(),
            receivedAmount: credit.amount,
            receivedAmountBaseUnits: credit.amountBaseUnits,
            expectedAmount: credit.amount,
            depositorAddresses: credit.fromAddress ? [credit.fromAddress] : [],
          },
        }
      );
    }

    logger.info(
      `[DepositAddress] Credited ${credit.amount} ${credit.asset} to user ${addrDoc.userId} ` +
        `from ${credit.txHash.slice(0, 12)}… (${credit.network})`
    );
    return "credited";
  } catch (err: any) {
    const attempts = Number(credit.attempts || 0) + 1;
    const giveUp = attempts >= MAX_CREDIT_ATTEMPTS;
    await DepositCreditModel.findByIdAndUpdate(credit._id, {
      $set: {
        attempts,
        lastError: String(err?.message || err).slice(0, 500),
        ...(giveUp ? { status: "failed" } : {}),
      },
    });
    logger.error(
      `[DepositAddress] Credit ${credit._id} attempt ${attempts} failed: ${err?.message || err}` +
        (giveUp ? " — MARKED FAILED, needs manual review (funds are safe on the deposit address)" : "")
    );
    if (giveUp) {
      await ActivityModel.create({
        userId: addrDoc.userId,
        title: "Deposit credit needs review",
        description: `Transfer ${credit.txHash} could not be booked automatically. Funds are held on the user's deposit address and are recoverable.`,
        type: "system",
        metadata: { creditId: String(credit._id), txHash: credit.txHash, amount: credit.amount },
      }).catch(() => {});
    }
    return "deferred";
  }
}

/** Retry loop for credits that were claimed but not yet booked. */
export async function retryPendingCredits(limit = 25): Promise<number> {
  const stuck = await DepositCreditModel.find({ status: "detected" })
    .sort({ createdAt: 1 })
    .limit(limit);
  let done = 0;
  for (const c of stuck) {
    const r = await finalizeCredit(c);
    if (r === "credited") done++;
  }
  return done;
}

/**
 * Credit a raw amount detected by BALANCE, not by a Transfer log.
 *
 * WHY THIS EXISTS
 * `eth_getLogs` is unavailable or crippled on most free BSC endpoints, while
 * `balanceOf` (a plain eth_call) works everywhere. Without this, a deposit could sit
 * undetected purely because of an RPC limitation. This path lets the sweeper credit
 * what it can prove is on the address.
 *
 * TRADE-OFF, stated plainly: there is no txHash and no sender attribution, because we
 * never saw the transfer event. The AMOUNT is still exact — it is the on-chain balance
 * minus everything already credited — but the audit trail is weaker than the log path.
 * Prefer the scanner; use this when the scanner cannot see.
 *
 * IDEMPOTENT BY CONSTRUCTION: the synthetic key encodes the resulting credited total,
 * so re-running with unchanged state collides on the unique index and is a no-op.
 */
export async function creditFromBalance(
  addrDoc: any,
  amountBaseUnits: bigint,
  decimals: number,
  asset: "USDT" | "USDC",
  newCreditedTotal: bigint
): Promise<"credited" | "duplicate" | "deferred"> {
  if (amountBaseUnits <= 0n) return "duplicate";

  const txHash = `balance:${addrDoc.addressLookup}:${newCreditedTotal.toString()}`;
  const requestId = `xfer:${addrDoc.network}:${txHash}:0`;

  let credit: any;
  try {
    credit = await DepositCreditModel.create({
      userId: addrDoc.userId,
      addressId: addrDoc._id,
      network: addrDoc.network,
      asset,
      txHash,
      logIndex: 0,
      fromAddress: "",
      toAddress: addrDoc.address,
      tokenAddress: "",
      amountBaseUnits: amountBaseUnits.toString(),
      amount: Number(amountBaseUnits) / 10 ** decimals,
      decimals,
      requestId,
      status: "detected",
    });
  } catch (e: any) {
    if (e?.code === 11000) return "duplicate";
    throw e;
  }

  logger.warn(
    `[DepositAddress] Crediting ${credit.amount} ${asset} for ${addrDoc.address} from BALANCE ` +
      `(no Transfer log seen — RPC cannot serve eth_getLogs). Amount is exact; sender is unknown.`
  );
  return finalizeCredit(credit, addrDoc);
}