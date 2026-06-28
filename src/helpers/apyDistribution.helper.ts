import DepositModel from '../models/deposit.model';
import VaultModel from '../models/vault.model';
import UserModel from '../models/user.model';
import YieldLogModel from '../models/yieldLog.model';
import ReferralModel from '../models/referral.model';
import ActivityModel from '../models/activity.model';
import { REFERRAL_L1_PERCENT, REFERRAL_L2_PERCENT } from '../configs/constants';
import logger from '../configs/logger.config';

/**
 * Main APY distribution function - runs monthly via cron
 * For each active deposit: calculates monthly yield, credits to user, distributes referral commissions
 */
export const distributeMonthlyAPY = async () => {
  logger.info('[APY-CRON] Starting monthly APY distribution...');

  const activeVaults = await VaultModel.find({ status: 'active' });
  let totalDistributed = 0;
  let usersProcessed = 0;
  let errors = 0;

  for (const vault of activeVaults) {
    logger.info(`[APY-CRON] Processing vault: ${vault.name}`);

    const activeDeposits = await DepositModel.find({
      vaultId: vault._id,
      status: 'active',
    });

    for (const deposit of activeDeposits) {
      try {
        const settled = await settleDepositYield(deposit);
        if (settled > 0) {
          totalDistributed += settled;
          usersProcessed++;
        }
      } catch (err: any) {
        errors++;
        logger.error(`[APY-CRON] Error processing deposit ${deposit._id}: ${err.message}`);
      }
    }
  }

  logger.info(`[APY-CRON] Distribution complete. Total: $${totalDistributed.toFixed(2)}, Users: ${usersProcessed}, Errors: ${errors}`);
  return { totalDistributed, usersProcessed, errors };
};

/**
 * Continuous yield accrual — the single source of truth for crediting yield.
 *
 * Yield accrues every second (not in 30-day jumps). The amount EARNED by `now` is
 *   entitled = min( monthlyYield * elapsed/30days , monthlyYield * maxYieldPayments )
 * and `totalYieldPaid` is the running total already credited. We credit the difference.
 *
 * This is drift-free and idempotent: re-running it credits nothing extra, because it
 * compares absolute elapsed time to what's already been paid. It's called BOTH by the
 * daily cron (to keep wallets fresh for display) AND on-demand when a user withdraws
 * yield — which is what makes yield withdrawable anytime.
 *
 * Returns the amount newly credited (0 if nothing was due).
 */
export const settleDepositYield = async (deposit: any, opts: { log?: boolean } = {}): Promise<number> => {
  const log = opts.log !== false; // default true (cron). Pass {log:false} for on-demand settles.
  const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
  const monthlyYield = (deposit.amount * (deposit.apyPercent / 12)) / 100; // apyPercent is ANNUAL
  if (monthlyYield <= 0) return 0;

  const maxTotal = monthlyYield * (deposit.maxYieldPayments || 0);
  const createdMs = new Date(deposit.createdAt as any).getTime();
  const elapsedMs = Date.now() - createdMs;

  const entitled = Math.min(monthlyYield * (elapsedMs / CYCLE_MS), maxTotal);
  const alreadyPaid = deposit.totalYieldPaid || 0;
  const unpaid = entitled - alreadyPaid;

  // A deposit ONLY matures when its full term of time has actually elapsed — never
  // because a (possibly stale) dollar total reached the cap. This is critical: it
  // prevents a deposit from being wrongly closed while the principal is still locked.
  const termComplete = deposit.maxYieldPayments > 0 && elapsedMs >= deposit.maxYieldPayments * CYCLE_MS;

  // Nothing meaningful to credit (ignore sub-dust so we don't create $0.0000 log rows).
  if (unpaid < 1e-6) {
    if (termComplete && deposit.status === 'active') {
      await DepositModel.findByIdAndUpdate(deposit._id, { status: 'matured' });
    }
    return 0;
  }

  const user = await UserModel.findById(deposit.userId);
  if (!user || user.status !== 'active') return 0;

  const yieldField = deposit.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';

  await UserModel.findByIdAndUpdate(user._id, { $inc: { [yieldField]: unpaid } });

  await DepositModel.findByIdAndUpdate(deposit._id, {
    $inc: { totalYieldPaid: unpaid, yieldPaymentsCount: 1 },
    ...(termComplete ? { status: 'matured' } : {}),
  });

  // Logs / activity / referral are the "official accounting" — only created by the daily
  // cron, NOT by the silent on-demand settle that runs when a user withdraws. That keeps
  // "Recent Yield Payments" free of a new row for every withdraw click.
  if (log) {
    await YieldLogModel.create({
      userId: user._id,
      depositId: deposit._id,
      vaultId: deposit.vaultId,
      amount: unpaid,
      asset: deposit.asset,
      apyPercent: deposit.apyPercent,
      depositAmount: deposit.amount,
      paymentNumber: (deposit.yieldPaymentsCount || 0) + 1,
      source: 'vault_apy',
    });
    await ActivityModel.create({
      userId: user._id,
      title: 'APY Yield Credited',
      description: `$${unpaid.toFixed(6)} ${deposit.asset} yield accrued`,
      type: 'yield',
      metadata: { vaultId: deposit.vaultId, depositId: deposit._id, amount: unpaid },
    });
    // Referral commissions on the newly accrued yield (L1 0.35%, L2 0.15% of yield).
    await distributeReferralCommissions(user._id, unpaid, deposit.asset, deposit._id, deposit.vaultId);
  }

  return unpaid;
};

/**
 * Settle ONE deposit's accrued yield (silently, no log) and return how much of THIS
 * deposit's yield is withdrawable right now: credited minus already-withdrawn, capped
 * at the user's actual wallet balance for the asset (the binding safety constraint).
 */
export const getWithdrawableDepositYield = async (
  deposit: any
): Promise<number> => {
  await settleDepositYield(deposit, { log: false });
  const fresh = await DepositModel.findById(deposit._id);
  if (!fresh) return 0;
  const user = await UserModel.findById(fresh.userId);
  if (!user) return 0;
  const field = fresh.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
  const walletBal = Number((user as any)[field] || 0);
  const ownYield = Number(fresh.totalYieldPaid || 0) - Number((fresh as any).yieldWithdrawn || 0);
  return Math.max(0, Math.min(ownYield, walletBal));
};

/**
 * Settle (credit) all of a user's currently-accrued yield for one asset, then return the
 * user's resulting withdrawable yield-wallet balance for that asset. Called right before a
 * yield withdrawal so the user can take out everything they've earned, at any moment.
 */
export const settleUserYieldForAsset = async (
  userId: string,
  asset: string
): Promise<number> => {
  const deposits = await DepositModel.find({ userId, asset, status: 'active' });
  for (const d of deposits) {
    try { await settleDepositYield(d, { log: false }); } catch (e: any) {
      logger.error(`[YieldSettle] deposit ${d._id}: ${e.message}`);
    }
  }
  const user = await UserModel.findById(userId);
  if (!user) return 0;
  const field = asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
  return Number((user as any)[field] || 0);
};

/**
 * Distribute referral commissions for a yield payment
 * L1 (direct referrer) gets 0.35% of yield
 * L2 (referrer's referrer) gets 0.15% of yield
 */
async function distributeReferralCommissions(
  userId: any, yieldAmount: number, asset: string, depositId: any, vaultId: any
) {
  try {
    const user = await UserModel.findById(userId);
    if (!user?.referredBy) return;

    // Level 1 - Direct referrer
    const l1Referrer = await UserModel.findById(user.referredBy);
    if (l1Referrer && l1Referrer.status === 'active') {
      const l1Commission = yieldAmount * (REFERRAL_L1_PERCENT / 100);
      if (l1Commission > 0) {
        await UserModel.findByIdAndUpdate(l1Referrer._id, {
          $inc: { referralEarnings: l1Commission }
        });
        await YieldLogModel.create({
          userId: l1Referrer._id,
          depositId, vaultId,
          amount: l1Commission, asset,
          apyPercent: REFERRAL_L1_PERCENT,
          depositAmount: yieldAmount,
          paymentNumber: 0,
          source: 'referral_l1',
          referredUserId: userId,
        });
        await ActivityModel.create({
          userId: l1Referrer._id,
          title: 'Referral Commission (L1)',
          description: `$${l1Commission.toFixed(4)} ${asset} from L1 referral yield`,
          type: 'referral',
          metadata: { fromUser: userId, level: 1, amount: l1Commission }
        });

        // Level 2 - Referrer's referrer
        if (l1Referrer.referredBy) {
          const l2Referrer = await UserModel.findById(l1Referrer.referredBy);
          if (l2Referrer && l2Referrer.status === 'active') {
            const l2Commission = yieldAmount * (REFERRAL_L2_PERCENT / 100);
            if (l2Commission > 0) {
              await UserModel.findByIdAndUpdate(l2Referrer._id, {
                $inc: { referralEarnings: l2Commission }
              });
              await YieldLogModel.create({
                userId: l2Referrer._id,
                depositId, vaultId,
                amount: l2Commission, asset,
                apyPercent: REFERRAL_L2_PERCENT,
                depositAmount: yieldAmount,
                paymentNumber: 0,
                source: 'referral_l2',
                referredUserId: userId,
              });
              await ActivityModel.create({
                userId: l2Referrer._id,
                title: 'Referral Commission (L2)',
                description: `$${l2Commission.toFixed(4)} ${asset} from L2 referral yield`,
                type: 'referral',
                metadata: { fromUser: userId, level: 2, amount: l2Commission }
              });
            }
          }
        }
      }
    }
  } catch (err: any) {
    logger.error(`[REFERRAL] Error distributing commissions for user ${userId}: ${err.message}`);
  }
}

// Email integration - called from the main distributeMonthlyAPY function
// Add this import at top: import { sendEmail } from '../configs/email.config';
// Then after crediting yield to user, call:
// await sendEmail(user.email, '💰 Your Yield Has Been Credited — Aussivo.DEX', 'apy-credit', { ... });