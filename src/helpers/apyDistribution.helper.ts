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
 * 30-DAY MATURATION — the single source of truth for crediting yield.
 *
 * Yield now matures in whole 30-day cycles instead of accruing continuously. Each time a
 * deposit crosses a 30-day boundary, that cycle's monthly yield "matures": it's credited to
 * the user's withdrawable yield wallet (yieldWalletUSDT/USDC) and the deposit's live counter
 * resets to 0 for the next cycle. Un-matured yield inside the current (incomplete) cycle is
 * NOT withdrawable and is forfeited if the principal is withdrawn before that cycle completes.
 *
 * This function is idempotent: it credits ONLY newly-completed cycles (tracked by
 * `cyclesMatured`), so it can be called safely from the daily cron, on portfolio load, and
 * right before a withdrawal without ever double-crediting. Because a maturation is a real,
 * discrete monthly event, it always writes a YieldLog + referral commissions when it fires.
 *
 * Returns the amount newly matured (0 if no new cycle completed).
 */
export const settleDepositYield = async (deposit: any, _opts: { log?: boolean } = {}): Promise<number> => {
  const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
  const monthlyYield = (deposit.amount * (deposit.apyPercent / 12)) / 100; // apyPercent is ANNUAL
  const maxCycles = Number(deposit.maxYieldPayments || 0);
  if (monthlyYield <= 0 || maxCycles <= 0) return 0;

  const createdMs = new Date(deposit.createdAt as any).getTime();
  const elapsedMs = Date.now() - createdMs;

  // Whole 30-day cycles that have fully elapsed, capped at the deposit's term.
  const completedCycles = Math.min(Math.floor(elapsedMs / CYCLE_MS), maxCycles);
  // Backward-compat: deposits created under the previous (continuous) model already had yield
  // credited (tracked in totalYieldPaid) but have cyclesMatured = 0. Treat the equivalent number
  // of already-paid cycles as matured so migration never re-credits them (idempotent on old data).
  const paidCycles = Math.floor((Number(deposit.totalYieldPaid || 0) / monthlyYield) + 1e-9);
  const alreadyMatured = Math.max(Number(deposit.cyclesMatured || 0), paidCycles);
  const newCycles = completedCycles - alreadyMatured;

  // Term is complete once every cycle has matured — principal stays redeemable, just no more yield.
  const termComplete = completedCycles >= maxCycles;

  if (newCycles <= 0) {
    if (termComplete && deposit.status === 'active') {
      await DepositModel.findByIdAndUpdate(deposit._id, { status: 'matured' });
    }
    return 0;
  }

  const user = await UserModel.findById(deposit.userId);
  if (!user || user.status !== 'active') return 0;

  const matureAmount = newCycles * monthlyYield;
  const yieldField = deposit.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';

  // Credit the matured yield into the user's WITHDRAWABLE bucket.
  await UserModel.findByIdAndUpdate(user._id, { $inc: { [yieldField]: matureAmount } });

  await DepositModel.findByIdAndUpdate(deposit._id, {
    $inc: {
      totalYieldPaid: matureAmount,
      maturedYield: matureAmount,
      yieldPaymentsCount: newCycles,
    },
    cyclesMatured: completedCycles,
    ...(termComplete ? { status: 'matured' } : {}),
  });

  // A matured cycle is official accounting: always logged, and always pays referral commissions.
  await YieldLogModel.create({
    userId: user._id,
    depositId: deposit._id,
    vaultId: deposit.vaultId,
    amount: matureAmount,
    asset: deposit.asset,
    apyPercent: deposit.apyPercent,
    depositAmount: deposit.amount,
    paymentNumber: completedCycles,
    source: 'vault_apy',
  });
  await ActivityModel.create({
    userId: user._id,
    title: 'Yield Matured',
    description: `$${matureAmount.toFixed(6)} ${deposit.asset} matured (${newCycles} × 30-day cycle) and is now withdrawable`,
    type: 'yield',
    metadata: { vaultId: deposit.vaultId, depositId: deposit._id, amount: matureAmount, cycles: newCycles },
  });
  await distributeReferralCommissions(user._id, matureAmount, deposit.asset, deposit._id, deposit.vaultId);

  return matureAmount;
};

/**
 * Live (un-matured) yield for the CURRENT, incomplete 30-day cycle of one deposit.
 * This is the number the portfolio shows as "accruing this cycle" — it climbs from 0 to one
 * monthly-yield over 30 days, then resets to 0 when the cycle matures. It is NOT withdrawable.
 */
export const computeLiveCycleYield = (deposit: any): number => {
  const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
  const monthlyYield = (deposit.amount * (deposit.apyPercent / 12)) / 100;
  const maxCycles = Number(deposit.maxYieldPayments || 0);
  if (monthlyYield <= 0 || maxCycles <= 0) return 0;
  const elapsedMs = Date.now() - new Date(deposit.createdAt as any).getTime();
  const completedCycles = Math.min(Math.floor(elapsedMs / CYCLE_MS), maxCycles);
  if (completedCycles >= maxCycles) return 0; // term done, nothing accruing
  const fracMs = elapsedMs - completedCycles * CYCLE_MS;
  return Math.max(0, monthlyYield * (fracMs / CYCLE_MS));
};

/**
 * Mature ONE deposit's completed cycles (idempotent) and return how much of THIS deposit's
 * matured yield is still withdrawable: matured minus already-withdrawn, capped at the user's
 * actual wallet balance for the asset (the binding safety constraint).
 */
export const getWithdrawableDepositYield = async (
  deposit: any
): Promise<number> => {
  await settleDepositYield(deposit);
  const fresh = await DepositModel.findById(deposit._id);
  if (!fresh) return 0;
  const user = await UserModel.findById(fresh.userId);
  if (!user) return 0;
  const field = fresh.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
  const walletBal = Number((user as any)[field] || 0);
  const ownMatured = Number((fresh as any).maturedYield || 0) - Number((fresh as any).maturedYieldWithdrawn || 0);
  return Math.max(0, Math.min(ownMatured, walletBal));
};

/**
 * Mature (credit) all of a user's newly-completed cycles for one asset, then return the user's
 * resulting withdrawable yield-wallet balance for that asset. Called right before a yield
 * withdrawal so the user can take out everything that has matured to date.
 */
export const settleUserYieldForAsset = async (
  userId: string,
  asset: string
): Promise<number> => {
  const deposits = await DepositModel.find({ userId, asset, status: 'active' });
  for (const d of deposits) {
    try { await settleDepositYield(d); } catch (e: any) {
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