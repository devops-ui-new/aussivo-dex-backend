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
        // Check if already paid this month
        const lastYield = await YieldLogModel.findOne({
          depositId: deposit._id,
          source: 'vault_apy',
        }).sort({ createdAt: -1 });

        if (lastYield) {
          const daysSinceLast = (Date.now() - lastYield.createdAt.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceLast < 25) { // buffer: at least 25 days between payments
            continue;
          }
        }

        // Check if max payments reached
        if (deposit.yieldPaymentsCount >= deposit.maxYieldPayments) {
          await DepositModel.findByIdAndUpdate(deposit._id, { status: 'matured' });
          logger.info(`[APY-CRON] Deposit ${deposit._id} matured after ${deposit.yieldPaymentsCount} payments`);
          continue;
        }

        // Calculate monthly yield
        const monthlyYield = (deposit.amount * deposit.apyPercent) / 100;
        if (monthlyYield <= 0) continue;

        const user = await UserModel.findById(deposit.userId);
        if (!user || user.status !== 'active') continue;

        // Credit yield to user's yield wallet
        const yieldField = deposit.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
        await UserModel.findByIdAndUpdate(user._id, {
          $inc: { [yieldField]: monthlyYield }
        });

        // Log yield payment
        await YieldLogModel.create({
          userId: user._id,
          depositId: deposit._id,
          vaultId: vault._id,
          amount: monthlyYield,
          asset: deposit.asset,
          apyPercent: deposit.apyPercent,
          depositAmount: deposit.amount,
          paymentNumber: deposit.yieldPaymentsCount + 1,
          source: 'vault_apy',
        });

        // Update deposit
        await DepositModel.findByIdAndUpdate(deposit._id, {
          $inc: { totalYieldPaid: monthlyYield, yieldPaymentsCount: 1 }
        });

        // Activity log
        await ActivityModel.create({
          userId: user._id,
          title: 'APY Yield Credited',
          description: `$${monthlyYield.toFixed(2)} ${deposit.asset} yield from ${vault.name}`,
          type: 'yield',
          metadata: { vaultId: vault._id, depositId: deposit._id, amount: monthlyYield }
        });

        totalDistributed += monthlyYield;
        usersProcessed++;

        // ── REFERRAL COMMISSIONS ──
        await distributeReferralCommissions(user._id, monthlyYield, deposit.asset, deposit._id, vault._id);

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
