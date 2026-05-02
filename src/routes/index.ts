import express from 'express';
import userRoutes from './user.routes';
import adminRoutes from './admin.routes';
import VaultModel from '../models/vault.model';
import UserModel from '../models/user.model';
import DepositModel from '../models/deposit.model';
import { sendResponse } from '../utils/response.util';

const router = express.Router();

router.use('/user', userRoutes);
router.use('/admin', adminRoutes);

// ═══ Frontend compatibility routes ═══

const formatVault = (v: any) => {
  const tierMonthly = v.tiers?.[0]?.apyPercent || 0;
  const annual = v.displayApy != null ? v.displayApy : tierMonthly * 12;
  const monthly = v.displayApyMonthly != null ? v.displayApyMonthly : (v.displayApy != null ? v.displayApy / 12 : tierMonthly);
  return {
  ...v.toObject ? v.toObject() : v,
  id: v._id,
  apy: Number(annual).toFixed(1),
  apyMonthly: Number(monthly).toFixed(2),
  apy_bps: Math.round(Number(monthly) * 100),
  lockDays: v.lockDays || 0,
  lock_period: (v.lockDays || 0) * 86400,
  totalStakedFormatted: (v.totalStaked || 0).toLocaleString(),
  capacityFormatted: (v.capacity || 0).toLocaleString(),
  utilization: v.capacity > 0 ? ((v.totalStaked / v.capacity) * 100).toFixed(1) : '0',
  assetSymbol: v.asset,
  total_staked: (v.totalStaked || 0) * 1e6,
  min_deposit: (v.minDeposit || 0) * 1e6,
  max_deposit: (v.maxDeposit || 0) * 1e6,
  capacity: (v.capacity || 0) * 1e6,
  early_exit_fee_bps: v.earlyExitFeeBps || 0,
  active: v.status === 'active' ? 1 : 0,
  };
};

// /api/pools → list all active vaults
router.get('/pools', async (req, res) => {
  try {
    const vaults = await VaultModel.find({ status: 'active' }).sort({ createdAt: -1 });
    res.json(vaults.map(formatVault));
  } catch { res.json([]); }
});

// /api/pools/:id → single vault detail
router.get('/pools/:id', async (req, res) => {
  try {
    const vault = await VaultModel.findById(req.params.id);
    if (!vault) return res.status(404).json({ error: 'Not found' });
    const depositorCount = await DepositModel.countDocuments({ vaultId: req.params.id, status: 'active' });
    res.json({ ...formatVault(vault), depositorCount });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// /api/stats → platform statistics
router.get('/stats', async (req, res) => {
  try {
    const [tvlAgg, poolCount, userCount, depositCount] = await Promise.all([
      VaultModel.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$totalStaked' } } }]),
      VaultModel.countDocuments({ status: 'active' }),
      UserModel.countDocuments({ status: 'active' }),
      DepositModel.countDocuments(),
    ]);
    res.json({ tvl: (tvlAgg[0]?.total || 0).toFixed(2), activePools: poolCount, totalUsers: userCount, totalDeposits: depositCount });
  } catch { res.json({ tvl: '0', activePools: 0, totalUsers: 0, totalDeposits: 0 }); }
});

export default router;
