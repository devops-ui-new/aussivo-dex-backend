import express from 'express';
import userRoutes from './user.routes';
import adminRoutes from './admin.routes';
import AdminController from '../controllers/admin.controller';
import { authenticateReportKey } from '../middlewares/auth.middleware';
import VaultModel from '../models/vault.model';
import UserModel from '../models/user.model';
import DepositModel from '../models/deposit.model';
import WithdrawRequestModel from '../models/withdrawRequest.model';
import { sendResponse } from '../utils/response.util';
import { buildAllocation } from '../helpers/allocationModel';
import { ALLOC_LIVE_MODEL, ALLOC_REBALANCE_MS, ALLOC_DECIMALS } from '../configs/constants';

const router = express.Router();

// Illustrative live allocation for a vault at the current instant. TARGET MODEL only —
// deterministic (pure clock + vault id), never live on-chain positions. Returns the
// strategies in the exact shape the frontend already renders, plus a little metadata.
const liveAllocationFor = (v: any) => {
  const r = buildAllocation(
    { id: String(v._id), name: v.name, strategyTheme: v.strategyTheme },
    { rebalancePeriodMs: ALLOC_REBALANCE_MS, decimals: ALLOC_DECIMALS }
  );
  return {
    strategies: r.strategies.map((s) => ({
      name: s.name,
      allocation: s.allocation,
      protocol: s.protocol,
      color: s.color,
      apy: s.apy,
      status: s.status,
      category: s.category,
      code: s.code,
      contract: s.contract,
    })),
    meta: {
      live: true,
      themeLabel: r.themeLabel,
      blendedApy: r.blendedApy,
      epoch: r.epoch,
      rebalancePeriodMs: r.rebalancePeriodMs,
      msToNextRebalance: r.msToNextRebalance,
    },
  };
};

router.use('/user', userRoutes);
router.use('/admin', adminRoutes);

// ── Read-only reports (partner teams) — API-key gated, no admin JWT, GET only ──
router.get('/reports/treasury-summary', authenticateReportKey, async (req, res) => {
  const r = await new AdminController(req as any, res as any).getTreasurySummary();
  return sendResponse(res, r.status, r);
});

// ═══ Frontend compatibility routes ═══

const formatVault = (v: any) => {
  // Tier apyPercent and displayApy are ANNUAL %. Monthly = annual / 12.
  const tierAnnual = v.tiers?.[0]?.apyPercent || 0;
  const annual = v.displayApy != null ? v.displayApy : tierAnnual;
  const monthly = v.displayApyMonthly != null ? v.displayApyMonthly : (annual / 12);

  // When the live model is on, replace the stored strategies with the drifting,
  // precise target allocation. When off, the DB strategies are served unchanged.
  const live = ALLOC_LIVE_MODEL ? liveAllocationFor(v) : null;

  return {
  ...v.toObject ? v.toObject() : v,
  ...(live ? { strategies: live.strategies, allocationMeta: live.meta } : { allocationMeta: { live: false } }),
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
  baseline_staked: (v.baselineStaked || 0) * 1e6,
  baseline_users: v.baselineUsers || 0,
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

// /api/pools/:id/allocation → just the current illustrative allocation snapshot.
// Small payload the frontend can poll every few seconds for the "live" feel without
// re-fetching the whole vault. When the live model is off, returns the stored strategies.
router.get('/pools/:id/allocation', async (req, res) => {
  try {
    const vault = await VaultModel.findById(req.params.id);
    if (!vault) return res.status(404).json({ error: 'Not found' });
    if (!ALLOC_LIVE_MODEL) {
      return res.json({ strategies: (vault as any).strategies || [], meta: { live: false } });
    }
    return res.json(liveAllocationFor(vault));
  } catch { return res.status(404).json({ error: 'Not found' }); }
});

// /api/stats → platform statistics.
// TVL and users are reported as REAL (live deposits) + a fixed launch BASELINE, plus the combined
// total. Users are summed from the same vault fields the pool cards use, so hero and cards reconcile.
router.get('/stats', async (req, res) => {
  try {
    const [agg, poolCount, depositCount, withdrawCount] = await Promise.all([
      VaultModel.aggregate([
        { $match: { status: 'active' } },
        { $group: {
          _id: null,
          realStaked: { $sum: '$totalStaked' },
          baselineStaked: { $sum: '$baselineStaked' },
          realUsers: { $sum: '$totalUsers' },
          baselineUsers: { $sum: '$baselineUsers' },
          baselineTransactions: { $sum: '$baselineTransactions' },
        } },
      ]),
      VaultModel.countDocuments({ status: 'active' }),
      DepositModel.countDocuments({ excludedFromAccounting: { $ne: true } }),
      WithdrawRequestModel.countDocuments({ status: 'completed' }),
    ]);
    const a = agg[0] || {};
    const realTvl = a.realStaked || 0;
    const baselineTvl = a.baselineStaked || 0;
    const realUsers = a.realUsers || 0;
    const baselineUsers = a.baselineUsers || 0;
    const realTx = (depositCount || 0) + (withdrawCount || 0); // real on-platform transactions
    const baselineTx = a.baselineTransactions || 0;
    res.json({
      // combined (what the big number shows)
      tvl: (realTvl + baselineTvl).toFixed(2),
      totalUsers: realUsers + baselineUsers,
      activePools: poolCount,
      totalDeposits: realTx + baselineTx,           // "Transactions Executed" = real + baseline
      // disclosed split so the UI can show the baseline as a baseline
      tvlReal: realTvl.toFixed(2),
      tvlBaseline: baselineTvl.toFixed(2),
      usersReal: realUsers,
      usersBaseline: baselineUsers,
      txReal: realTx,
      txBaseline: baselineTx,
      hasBaseline: baselineTvl > 0 || baselineUsers > 0 || baselineTx > 0,
    });
  } catch {
    res.json({ tvl: '0', activePools: 0, totalUsers: 0, totalDeposits: 0, tvlReal: '0', tvlBaseline: '0', usersReal: 0, usersBaseline: 0, txReal: 0, txBaseline: 0, hasBaseline: false });
  }
});

export default router;