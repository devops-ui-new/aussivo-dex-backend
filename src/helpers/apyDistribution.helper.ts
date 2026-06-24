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
        // ── 30-DAY ROLLING CYCLES (per deposit, anchored on its own start date) ──
        // Yield is credited once for every full 30 days the deposit has been active,
        // measured from `createdAt` (NOT calendar months). This is drift-free and
        // catch-up safe: the number paid is always derived from elapsed time vs the
        // number already paid, so a missed/duplicate cron run can never over- or
        // under-pay. The live per-hour figure shown in the UI is only an estimate;
        // the withdrawable balance steps up here, every 30 days.
        const CYCLE_MS = 30 * 24 * 60 * 60 * 1000; // one 30-day cycle
        const createdMs = new Date(deposit.createdAt as any).getTime();
        const elapsedMs = Date.now() - createdMs;

        // Whole 30-day cycles earned so far, capped at the deposit's term.
        const cyclesEarned = Math.min(
          Math.floor(elapsedMs / CYCLE_MS),
          deposit.maxYieldPayments
        );
        const alreadyPaid = deposit.yieldPaymentsCount || 0;
        const cyclesToPay = cyclesEarned - alreadyPaid;

        if (cyclesToPay <= 0) {
          // Nothing new is due yet. Mark matured once the full term has been paid.
          if (alreadyPaid >= deposit.maxYieldPayments) {
            await DepositModel.findByIdAndUpdate(deposit._id, { status: 'matured' });
            logger.info(`[APY-CRON] Deposit ${deposit._id} matured after ${alreadyPaid} payments`);
          }
          continue;
        }

        // apyPercent is the ANNUAL APY %. Each 30-day cycle pays principal * (annual / 12) / 100.
        const monthlyYield = (deposit.amount * (deposit.apyPercent / 12)) / 100;
        if (monthlyYield <= 0) continue;

        const user = await UserModel.findById(deposit.userId);
        if (!user || user.status !== 'active') continue;

        const yieldField = deposit.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';

        // Credit each completed 30-day cycle since the last payout (normally 1;
        // only > 1 if the cron was offline across multiple cycles).
        for (let k = 1; k <= cyclesToPay; k++) {
          const paymentNumber = alreadyPaid + k;

          await UserModel.findByIdAndUpdate(user._id, {
            $inc: { [yieldField]: monthlyYield }
          });

          await YieldLogModel.create({
            userId: user._id,
            depositId: deposit._id,
            vaultId: vault._id,
            amount: monthlyYield,
            asset: deposit.asset,
            apyPercent: deposit.apyPercent,
            depositAmount: deposit.amount,
            paymentNumber,
            source: 'vault_apy',
          });

          await ActivityModel.create({
            userId: user._id,
            title: 'APY Yield Credited',
            description: `$${monthlyYield.toFixed(2)} ${deposit.asset} yield from ${vault.name} (30-day cycle ${paymentNumber}/${deposit.maxYieldPayments})`,
            type: 'yield',
            metadata: { vaultId: vault._id, depositId: deposit._id, amount: monthlyYield, paymentNumber }
          });

          totalDistributed += monthlyYield;

          // Referral commissions on each cycle's yield (L1 0.35%, L2 0.15% of yield).
          await distributeReferralCommissions(user._id, monthlyYield, deposit.asset, deposit._id, vault._id);
        }

        // Advance the deposit's paid-cycle counter once for the whole batch.
        await DepositModel.findByIdAndUpdate(deposit._id, {
          $inc: { totalYieldPaid: monthlyYield * cyclesToPay, yieldPaymentsCount: cyclesToPay }
        });

        usersProcessed++;

        if (alreadyPaid + cyclesToPay >= deposit.maxYieldPayments) {
          await DepositModel.findByIdAndUpdate(deposit._id, { status: 'matured' });
          logger.info(`[APY-CRON] Deposit ${deposit._id} matured after ${alreadyPaid + cyclesToPay} payments`);
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