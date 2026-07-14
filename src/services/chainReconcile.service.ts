/**
 * chainReconcile.service.ts — safety net that catches anything the live attest path missed.
 *
 * For every user with a wallet and an active position, compare the DB principal to the on-chain
 * attestation. Any mismatch (missed attest, failed tx that exhausted retries, manual DB edit) is
 * re-queued via the outbox. Then stamp markGlobalSync so the on-chain aggregate matches the DB.
 *
 * Runs nightly (and on-demand from the admin panel). Read-only against chain except the re-queue.
 */
import mongoose from 'mongoose';
import DepositModel from '../models/deposit.model';
import UserModel from '../models/user.model';
import logger from '../configs/logger.config';
import { ethers } from 'ethers';
import { isRegistryV2Enabled, readPosition, toCents, markGlobalSyncOnChain } from './registryV2.service';
import { enqueueAttest } from './chainSync.worker';

export interface ReconcileReport {
  ran: boolean;
  checked: number;
  drifted: number;
  requeued: number;
  totalUsers: number;
  totalPrincipalCents: number;
  driftSamples: Array<{ wallet: string; dbCents: number; chainCents: string }>;
  finishedAt: string;
}

let lastReport: ReconcileReport | null = null;
export function getLastReconcileReport(): ReconcileReport | null { return lastReport; }

export async function reconcileChain(opts: { markGlobal?: boolean } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    ran: false, checked: 0, drifted: 0, requeued: 0,
    totalUsers: 0, totalPrincipalCents: 0, driftSamples: [], finishedAt: new Date().toISOString(),
  };
  if (!isRegistryV2Enabled()) { lastReport = report; return report; }
  report.ran = true;

  // DB positions per user (active/matured principal + count).
  const rows = await DepositModel.aggregate([
    { $match: { status: { $in: ['active', 'matured'] } } },
    { $group: { _id: '$userId', principal: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const userIds = rows.map((r) => r._id);
  const users = await UserModel.find({ _id: { $in: userIds } }, { walletAddress: 1 });
  const walletById = new Map(users.map((u) => [String(u._id), (u.walletAddress || '').trim()]));

  let totalUsers = 0;
  let totalPrincipalCents = 0;

  for (const r of rows) {
    const wallet = walletById.get(String(r._id));
    if (!wallet || !ethers.isAddress(wallet)) continue;
    const dbCents = Number(toCents(Number(r.principal || 0)));
    if (dbCents <= 0) continue;

    totalUsers += 1;
    totalPrincipalCents += dbCents;
    report.checked += 1;

    const onChain = await readPosition(wallet);
    const chainCents = onChain ? onChain.principalCents : '0';
    if (chainCents !== String(dbCents)) {
      report.drifted += 1;
      if (report.driftSamples.length < 25) report.driftSamples.push({ wallet, dbCents, chainCents });
      await enqueueAttest(r._id);
      report.requeued += 1;
    }
  }

  report.totalUsers = totalUsers;
  report.totalPrincipalCents = totalPrincipalCents;

  if (opts.markGlobal) {
    try {
      const tx = await markGlobalSyncOnChain(totalUsers, totalPrincipalCents);
      logger.info(`[Reconcile] markGlobalSync tx=${tx}`);
    } catch (e: any) {
      logger.warn(`[Reconcile] markGlobalSync failed: ${e?.message || e}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  lastReport = report;
  logger.info(`[Reconcile] checked=${report.checked} drifted=${report.drifted} requeued=${report.requeued}`);
  return report;
}