/**
 * chainSync.worker.ts — durable on-chain sync.
 *
 *  enqueueAttest(userId) — compute a user's current active principal + deposit count and queue an
 *  attest job (upserted by dedupeKey, so repeated calls collapse to the latest snapshot).
 *
 *  startChainSyncWorker() — in-process loop that claims due jobs and sends them, with exponential
 *  backoff on failure. Gas-out just leaves jobs pending; they resume when the signer is funded.
 *
 * This is the piece that makes "attest on every deposit" safe: the user's request never blocks on
 * chain latency, and a failed tx is retried rather than lost.
 */
import mongoose from 'mongoose';
import ChainOutbox from '../models/chainOutbox.model';
import DepositModel from '../models/deposit.model';
import UserModel from '../models/user.model';
import logger from '../configs/logger.config';
import {
  isRegistryV2Enabled,
  attestOnChain,
  toCents,
} from './registryV2.service';
import { ethers } from 'ethers';

const POLL_MS = 15_000;         // how often the worker looks for due jobs
const BATCH = 5;                // jobs processed per tick (sequential — one signer, one nonce)
const BACKOFF_BASE_MS = 30_000; // 30s, doubling each attempt (30s,1m,2m,4m,...)

/** Compute a user's current active principal (dollars) + deposit count from the DB. */
export async function computeUserPosition(userId: any): Promise<{ principal: number; count: number }> {
  const rows = await DepositModel.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)), status: { $in: ['active', 'matured'] } } },
    { $group: { _id: null, principal: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const r = rows[0] || { principal: 0, count: 0 };
  return { principal: Number(r.principal || 0), count: Number(r.count || 0) };
}

/**
 * Queue (or refresh) an attest job for a user. No-op if the registry isn't configured or the user
 * has no wallet. Safe to call on every deposit/withdrawal/link — it upserts by dedupeKey.
 */
export async function enqueueAttest(userId: any): Promise<void> {
  try {
    if (!isRegistryV2Enabled()) return;
    const user = await UserModel.findById(userId);
    const wallet = (user?.walletAddress || '').trim();
    if (!wallet || !ethers.isAddress(wallet)) return; // email-only users: nothing to attest

    const { principal, count } = await computeUserPosition(userId);
    const principalCents = Number(toCents(principal));
    const dedupeKey = `attest:${wallet.toLowerCase()}`;

    // Upsert the live job for this wallet to the newest snapshot; reset it to pending so the
    // worker picks it up even if a previous attempt had failed.
    await ChainOutbox.findOneAndUpdate(
      { dedupeKey, status: { $in: ['pending', 'processing'] } },
      {
        $set: {
          kind: 'attest', walletAddress: ethers.getAddress(wallet), userId: user!._id,
          principalCents, depositCount: count, dedupeKey,
          status: 'pending', nextAttemptAt: new Date(), lockedAt: null,
        },
        $setOnInsert: { attempts: 0 },
      },
      { upsert: true, new: true }
    );
  } catch (e: any) {
    logger.warn(`[ChainSync] enqueueAttest failed for ${userId}: ${e?.message || e}`);
  }
}

async function processOne(job: any): Promise<void> {
  try {
    let txHash = '';
    if (job.kind === 'attest') {
      txHash = await attestOnChain(job.walletAddress, job.principalCents, job.depositCount);
    } else {
      throw new Error(`Unknown job kind: ${job.kind}`);
    }
    await ChainOutbox.findByIdAndUpdate(job._id, { status: 'done', txHash, lastError: '', lockedAt: null });
  } catch (e: any) {
    const attempts = (job.attempts || 0) + 1;
    const failed = attempts >= (job.maxAttempts || 8);
    const backoff = BACKOFF_BASE_MS * Math.pow(2, Math.min(attempts - 1, 8));
    await ChainOutbox.findByIdAndUpdate(job._id, {
      status: failed ? 'failed' : 'pending',
      attempts,
      nextAttemptAt: new Date(Date.now() + backoff),
      lastError: (e?.shortMessage || e?.message || String(e)).slice(0, 500),
      lockedAt: null,
    });
    logger.warn(`[ChainSync] job ${job._id} attempt ${attempts} failed: ${e?.shortMessage || e?.message || e}${failed ? ' (giving up)' : ''}`);
  }
}

async function tick(): Promise<void> {
  if (!isRegistryV2Enabled()) return;
  // Reclaim jobs stuck in 'processing' for >5min (e.g. a crash mid-send).
  await ChainOutbox.updateMany(
    { status: 'processing', lockedAt: { $lt: new Date(Date.now() - 5 * 60_000) } },
    { $set: { status: 'pending', lockedAt: null } }
  );

  for (let i = 0; i < BATCH; i++) {
    // Atomically claim the next due pending job.
    const job = await ChainOutbox.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: new Date() } },
      { $set: { status: 'processing', lockedAt: new Date() } },
      { sort: { nextAttemptAt: 1 }, new: true }
    );
    if (!job) break;
    await processOne(job); // sequential: single signer, avoid nonce collisions
  }
}

let started = false;
export function startChainSyncWorker(): void {
  if (started) return;
  started = true;
  if (!isRegistryV2Enabled()) {
    logger.info('[ChainSync] registry v2 not configured — worker idle.');
    return;
  }
  logger.info('[ChainSync] worker started.');
  const loop = async () => {
    try { await tick(); } catch (e: any) { logger.error(`[ChainSync] tick error: ${e?.message || e}`); }
    setTimeout(loop, POLL_MS);
  };
  setTimeout(loop, 5_000); // small delay so DB/connection is ready
}