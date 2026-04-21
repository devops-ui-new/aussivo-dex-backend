import VaultModel from '../models/vault.model';
import logger from '../configs/logger.config';

const MIN_DEPOSIT = 1;

export const seedVaults = async () => {
  try {
    const count = await VaultModel.countDocuments();
    if (count > 0) {
      const vaults = await VaultModel.find({});
      let updated = 0;
      for (const v of vaults) {
        let changed = false;
        if (v.minDeposit !== MIN_DEPOSIT) { v.minDeposit = MIN_DEPOSIT; changed = true; }
        if (v.tiers?.[0] && v.tiers[0].minAmount !== MIN_DEPOSIT) {
          v.tiers[0].minAmount = MIN_DEPOSIT;
          changed = true;
        }
        if (changed) { await v.save(); updated++; }
      }
      logger.info(`[SEED] ${count} vaults already exist — min deposit normalized to ${MIN_DEPOSIT} on ${updated} vault(s)`);
      return;
    }

    const vaults = [
      {
        name: 'Cryptobluechip',
        description: 'Diversified USDT strategy across top DeFi lending protocols. Capital is deployed to Aave V3, Compound, and Venus for optimized risk-adjusted returns with auto-rebalancing.',
        asset: 'USDT',
        vaultType: 'locked',
        lockDays: 30,
        durationMonths: 12,
        minDeposit: MIN_DEPOSIT,
        maxDeposit: 500000,
        capacity: 10000000,
        totalStaked: 2847500,
        totalUsers: 342,
        earlyExitFeeBps: 500,
        tiers: [
          { minAmount: MIN_DEPOSIT, maxAmount: 5000, apyPercent: 1.2 },
          { minAmount: 5000, maxAmount: 25000, apyPercent: 1.5 },
          { minAmount: 25000, maxAmount: 100000, apyPercent: 1.8 },
          { minAmount: 100000, maxAmount: 500000, apyPercent: 2.1 },
        ],
        strategies: [
          { name: 'Aave V3 Lending', allocation: 40, protocol: 'Aave' },
          { name: 'Compound Finance', allocation: 30, protocol: 'Compound' },
          { name: 'Venus Protocol', allocation: 20, protocol: 'Venus' },
          { name: 'Reserve Buffer', allocation: 10, protocol: 'Internal' },
        ],
        status: 'active',
      },
      {
        name: 'Defitracker',
        description: 'Market-neutral USDC strategy combining lending yields with delta-hedged positions. Designed for capital preservation with consistent monthly returns regardless of market direction.',
        asset: 'USDC',
        vaultType: 'locked',
        lockDays: 60,
        durationMonths: 6,
        minDeposit: MIN_DEPOSIT,
        maxDeposit: 250000,
        capacity: 5000000,
        totalStaked: 1235800,
        totalUsers: 187,
        earlyExitFeeBps: 750,
        tiers: [
          { minAmount: MIN_DEPOSIT, maxAmount: 10000, apyPercent: 1.0 },
          { minAmount: 10000, maxAmount: 50000, apyPercent: 1.35 },
          { minAmount: 50000, maxAmount: 250000, apyPercent: 1.65 },
        ],
        strategies: [
          { name: 'Funding Rate Arbitrage', allocation: 35, protocol: 'Binance' },
          { name: 'Aave V3 Lending', allocation: 30, protocol: 'Aave' },
          { name: 'Curve Stableswap', allocation: 25, protocol: 'Curve' },
          { name: 'Insurance Reserve', allocation: 10, protocol: 'Internal' },
        ],
        status: 'active',
      },
    ];

    await VaultModel.insertMany(vaults);
    logger.info(`[SEED] ✅ ${vaults.length} vaults seeded successfully`);
  } catch (err: any) {
    logger.error(`[SEED] Error seeding vaults: ${err.message}`);
  }
};
