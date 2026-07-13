import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import AdminModel from '../models/admin.model';
import UserModel from '../models/user.model';
import VaultModel from '../models/vault.model';
import DepositModel from '../models/deposit.model';
import YieldLogModel from '../models/yieldLog.model';
import WithdrawRequestModel from '../models/withdrawRequest.model';
import PendingDepositModel from '../models/pendingDeposit.model';
import ActivityModel from '../models/activity.model';
import { JWT_SECRET } from '../configs/constants';
import { IResponse } from '../utils/response.util';
import { distributeMonthlyAPY, computeLiveCycleYield } from '../helpers/apyDistribution.helper';
import { isVaultPayoutConfigured, payoutUserOnChain } from '../services/vaultPayout.service';
import { getGasFunderStatus, forceSweepPending as forceSweepBep } from '../services/ephemeralDepositSweep.service';
import { getTronGasFunderStatus, forceSweepPending as forceSweepTron } from '../services/tronDepositSweep.service';
import { deregisterUserOnChain } from '../services/userRegistry.service';
import { burnForWithdrawal } from '../services/stakedToken.service';
import logger from '../configs/logger.config';

export default class AdminController {
  req: Request;
  res: Response;
  adminId?: string;

  constructor(req: Request, res: Response) {
    this.req = req;
    this.res = res;
    this.adminId = req.body?.admin?.id;
  }

  // ── LOGIN ──
  async login(body: { email: string; password: string }): Promise<IResponse> {
    try {
      const admin = await AdminModel.findOne({ email: body.email?.toLowerCase(), status: 'active' });
      if (!admin) return { data: null, error: 'Not found', message: 'Invalid credentials', status: 401 };
      const valid = await bcrypt.compare(body.password, admin.password);
      if (!valid) return { data: null, error: 'Invalid', message: 'Invalid credentials', status: 401 };
      const token = jwt.sign({ id: admin._id, email: admin.email, role: admin.role }, JWT_SECRET, { expiresIn: '12h' });
      await AdminModel.findByIdAndUpdate(admin._id, { lastLogin: new Date() });
      return { data: { token, admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role } }, error: null, message: 'Login successful', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Login failed', status: 500 };
    }
  }

  // ── DASHBOARD ──
  async getDashboard(): Promise<IResponse> {
    try {
      const [totalUsers, totalDeposits, activeVaults, totalTVL, pendingWithdrawals, totalYieldDistributed, recentDeposits, feesAgg] = await Promise.all([
        UserModel.countDocuments({ status: 'active' }),
        DepositModel.countDocuments(),
        VaultModel.countDocuments({ status: 'active' }),
        VaultModel.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$totalStaked' } } }]),
        WithdrawRequestModel.countDocuments({ status: 'pending' }),
        YieldLogModel.aggregate([{ $match: { source: 'vault_apy' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        DepositModel.find().populate('userId', 'name email').populate('vaultId', 'name').sort({ createdAt: -1 }).limit(10),
        WithdrawRequestModel.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$fee' } } }]),
      ]);

      return {
        data: {
          totalUsers, totalDeposits, activeVaults,
          totalTVL: totalTVL[0]?.total || 0,
          pendingWithdrawals,
          totalYieldDistributed: totalYieldDistributed[0]?.total || 0,
          earlyExitFeesCollected: Math.round(((feesAgg[0]?.total) || 0) * 1e6) / 1e6,
          recentDeposits,
        },
        error: null, message: 'Dashboard data', status: 200
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── DEPOSIT SWEEP MONITOR ──
  // Per-chain view of what's in-flight and whether a gas funder is the bottleneck.
  async getSweepStatus(): Promise<IResponse> {
    try {
      const now = Date.now();
      const notSwept = { $or: [{ sweepTxHash: "" }, { sweepTxHash: { $exists: false } }] };
      const STUCK_MS = 3 * 60 * 1000;

      const perChain = async (network: 'bep20' | 'trc20') => {
        const [awaitingDeposit, awaitingSweep, swept, expired, stuckDocs] = await Promise.all([
          PendingDepositModel.countDocuments({ network, status: 'pending', expiresAt: { $gt: new Date(now) } }),
          PendingDepositModel.countDocuments({ network, status: 'credited', ...notSwept }),
          PendingDepositModel.countDocuments({ network, status: 'matched' }),
          PendingDepositModel.countDocuments({ network, status: 'expired' }),
          PendingDepositModel.find({
            network, status: 'credited', ...notSwept,
            userCreditedAt: { $lt: new Date(now - STUCK_MS) },
          }).select('ephemeralAddress asset receivedAmount expectedAmount userCreditedAt energyFundedAt').sort({ userCreditedAt: 1 }).limit(50).lean(),
        ]);
        const stuck = stuckDocs.map((d: any) => ({
          id: String(d._id),
          address: d.ephemeralAddress,
          asset: d.asset,
          amount: d.receivedAmount || d.expectedAmount || 0,
          waitingMinutes: d.userCreditedAt ? Math.round((now - new Date(d.userCreditedAt).getTime()) / 60000) : null,
          lastFundedAt: d.energyFundedAt || null,
        }));
        return { awaitingDeposit, awaitingSweep, swept, expired, stuckCount: stuck.length, stuck };
      };

      const [bep20, trc20, bscFunder, tronFunder] = await Promise.all([
        perChain('bep20'), perChain('trc20'), getGasFunderStatus(), getTronGasFunderStatus(),
      ]);

      // A funder that's low AND has deposits awaiting sweep = the reason things are stuck.
      const bscBlocked = bscFunder ? !bscFunder.ok && bep20.awaitingSweep > 0 : bep20.awaitingSweep > 0;
      const tronBlocked = tronFunder ? !tronFunder.ok && trc20.awaitingSweep > 0 : trc20.awaitingSweep > 0;

      return {
        data: {
          generatedAt: new Date(now).toISOString(),
          bep20: { ...bep20, gasFunder: bscFunder, funderBlocking: bscBlocked },
          trc20: { ...trc20, gasFunder: tronFunder, funderBlocking: tronBlocked },
        },
        error: null, message: 'Sweep status', status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // Admin action: force-process a single stuck deposit now (re-fund gas + sweep).
  async forceSweep(pendingId: string): Promise<IResponse> {
    try {
      const doc = await PendingDepositModel.findById(pendingId);
      if (!doc) return { data: null, error: 'Not found', message: 'Deposit not found', status: 404 };
      if (doc.status === 'matched') return { data: { status: 'matched' }, error: null, message: 'Already swept', status: 200 };

      if (doc.network === 'trc20') await forceSweepTron(pendingId);
      else await forceSweepBep(pendingId);

      const fresh: any = await PendingDepositModel.findById(pendingId).lean();
      const swept = fresh?.status === 'matched' || !!fresh?.sweepTxHash;
      return {
        data: { status: fresh?.status, sweepTxHash: fresh?.sweepTxHash || null, swept },
        error: null,
        message: swept ? 'Swept to treasury' : 'Retry triggered — if the gas funder is empty, top it up and retry',
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: `Force sweep failed: ${err.message}`, status: 500 };
    }
  }

  // Aggregate real USDT that landed from users — per chain (BEP-20 / TRC-20) and combined.
  // sweptToTreasury = reached treasury; inFlight = credited but still on ephemeral (not swept).
  async getTreasurySummary(): Promise<IResponse> {
    try {
      const amountExpr = { $cond: [{ $gt: ['$receivedAmount', 0] }, '$receivedAmount', '$expectedAmount'] };
      const rows = await PendingDepositModel.aggregate([
        { $match: { status: { $in: ['credited', 'matched'] } } },
        { $group: {
          _id: { network: '$network', status: '$status', asset: '$asset' },
          amount: { $sum: amountExpr },
          count: { $sum: 1 },
        } },
      ]);

      const blank = () => ({ sweptToTreasury: 0, inFlight: 0, totalReceived: 0, count: 0 });
      const byChain: any = { bep20: blank(), trc20: blank() };
      const byAsset: any = { USDT: blank(), USDC: blank() };
      const combined = blank();

      for (const r of rows) {
        const net = r._id.network === 'trc20' ? 'trc20' : 'bep20';
        const asset = r._id.asset === 'USDC' ? 'USDC' : 'USDT';
        const isSwept = r._id.status === 'matched';
        const amt = r.amount || 0;
        const bucket = isSwept ? 'sweptToTreasury' : 'inFlight';
        for (const t of [byChain[net], byAsset[asset], combined]) {
          t[bucket] += amt; t.totalReceived += amt; t.count += r.count;
        }
      }

      // Off-chain view: what's actually credited to user balances (deposits collection).
      const [activeAgg, allAgg] = await Promise.all([
        DepositModel.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        DepositModel.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
      ]);

      const round = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'count' ? v : Math.round(Number(v) * 1e6) / 1e6]));

      return {
        data: {
          generatedAt: new Date().toISOString(),
          combined: round(combined),
          byChain: { bep20: round(byChain.bep20), trc20: round(byChain.trc20) },
          byAsset: { USDT: round(byAsset.USDT), USDC: round(byAsset.USDC) },
          creditedToUsers: {
            activePrincipal: Math.round((activeAgg[0]?.total || 0) * 1e6) / 1e6,
            allTime: Math.round((allAgg[0]?.total || 0) * 1e6) / 1e6,
          },
        },
        error: null, message: 'Treasury summary', status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── VAULT CRUD ──
  async createVault(body: any): Promise<IResponse> {
    try {
      const vault = await VaultModel.create(body);
      await ActivityModel.create({ adminId: this.adminId, title: 'Vault Created', description: `Vault "${vault.name}" created`, type: 'admin' });
      return { data: vault, error: null, message: 'Vault created', status: 201 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Failed to create vault', status: 500 };
    }
  }

  async updateVault(vaultId: string, body: any): Promise<IResponse> {
    try {
      const vault = await VaultModel.findByIdAndUpdate(vaultId, body, { new: true });
      if (!vault) return { data: null, error: 'Not found', message: 'Vault not found', status: 404 };
      await ActivityModel.create({ adminId: this.adminId, title: 'Vault Updated', description: `Vault "${vault.name}" updated`, type: 'admin' });
      return { data: vault, error: null, message: 'Vault updated', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Update failed', status: 500 };
    }
  }

  async getAllVaults(): Promise<IResponse> {
    try {
      const vaults = await VaultModel.find().sort({ createdAt: -1 });
      return { data: vaults, error: null, message: 'All vaults', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── USERS LIST ──
  async getUsers(page = 1, limit = 20, search?: string): Promise<IResponse> {
    try {
      const query: any = {};
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { walletAddress: { $regex: search, $options: 'i' } },
          { walletAddresses: { $regex: search, $options: 'i' } },
        ];
      }
      const skip = (page - 1) * limit;
      const [users, total] = await Promise.all([
        UserModel.find(query).select('-__v').sort({ createdAt: -1 }).skip(skip).limit(limit),
        UserModel.countDocuments(query),
      ]);
      return { data: { users, total, page, limit, pages: Math.ceil(total / limit) }, error: null, message: 'Users list', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  async getUserById(userId: string): Promise<IResponse> {
    try {
      const user = await UserModel.findById(userId);
      if (!user) return { data: null, error: 'Not found', message: 'User not found', status: 404 };
      const deposits = await DepositModel.find({ userId }).populate('vaultId', 'name');
      const yieldLogs = await YieldLogModel.find({ userId }).sort({ createdAt: -1 }).limit(50);
      const referrals = await UserModel.find({ referredBy: userId }).select('name email createdAt totalDeposited');
      return { data: { user, deposits, yieldLogs, referrals }, error: null, message: 'User details', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── DEPOSIT MANAGEMENT ──
  async getAllDeposits(page = 1, limit = 20, vaultId?: string, status?: string): Promise<IResponse> {
    try {
      const query: any = {};
      if (vaultId) query.vaultId = vaultId;
      if (status) query.status = status;
      const skip = (page - 1) * limit;
      const [deposits, total] = await Promise.all([
        DepositModel.find(query).populate('userId', 'name email walletAddress walletAddresses').populate('vaultId', 'name asset').sort({ createdAt: -1 }).skip(skip).limit(limit),
        DepositModel.countDocuments(query),
      ]);
      return { data: { deposits, total, page, limit }, error: null, message: 'All deposits', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── WITHDRAWAL MANAGEMENT ──
  async getWithdrawRequests(page = 1, limit = 20, status?: string): Promise<IResponse> {
    try {
      const query: any = {};
      if (status) query.status = status;
      const skip = (page - 1) * limit;
      const [requests, total] = await Promise.all([
        WithdrawRequestModel.find(query).populate('userId', 'name email walletAddress').sort({ createdAt: -1 }).skip(skip).limit(limit),
        WithdrawRequestModel.countDocuments(query),
      ]);
      return { data: { requests, total, page, limit }, error: null, message: 'Withdraw requests', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  async processWithdrawal(body: { requestId: string; action: 'approve' | 'reject'; txHash?: string; note?: string }): Promise<IResponse> {
    try {
      const { requestId, action, txHash, note } = body;
      const request = await WithdrawRequestModel.findById(requestId).populate('userId');
      if (!request || request.status !== 'pending') return { data: null, error: 'Not found', message: 'Request not found or already processed', status: 404 };

      if (action === 'approve') {
        // Atomically claim the request so a concurrent click can't double-spend.
        const claimed = await WithdrawRequestModel.findOneAndUpdate(
          { _id: requestId, status: 'pending' },
          { status: 'approved', reviewedBy: this.adminId, reviewNote: note || '' },
          { new: true }
        );
        if (!claimed) return { data: null, error: 'Conflict', message: 'Request already being processed', status: 409 };

        let finalTxHash = (txHash || '').trim();
        // Pay the NET amount (gross − early-exit fee). The fee stays in the treasury.
        const netPayout = (request as any).netAmount && (request as any).netAmount > 0 ? (request as any).netAmount : request.amount;

        // If no manual hash supplied and the vault signer is configured, auto-pay on-chain.
        if (!finalTxHash && isVaultPayoutConfigured()) {
          try {
            const result = await payoutUserOnChain({
              asset: request.asset as 'USDT' | 'USDC',
              userAddress: request.walletAddress,
              amount: netPayout,
              reason: `wdreq:${requestId}`,
            });
            finalTxHash = result.txHash;
          } catch (err: any) {
            // Revert the claim so the admin can retry (assumes tx did not land; admin must verify on-chain if ambiguous).
            await WithdrawRequestModel.findByIdAndUpdate(requestId, { status: 'pending', reviewedBy: null, reviewNote: `payout failed: ${err.message}` });
            const lowGas = err?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(err?.message || '');
            const friendly = lowGas
              ? 'Payout wallet is out of BNB for gas. Top up the payout wallet with BNB and approve again (the request is back to pending — nothing was lost).'
              : `On-chain payout failed: ${err.message}`;
            return { data: null, error: err.message, message: friendly, status: 500 };
          }
        }

        await WithdrawRequestModel.findByIdAndUpdate(requestId, { status: 'completed', txHash: finalTxHash });
        // userId may be a populated doc here — resolve to a plain id for the $inc updates.
        const uid = (request.userId as any)?._id || request.userId;
        await UserModel.findByIdAndUpdate(uid, { $inc: { totalWithdrawn: request.amount } });

        // ── The balance change happens HERE, on approval — never at submit time. ──
        if (request.source === 'deposit' && request.depositId) {
          // Principal redemption: close the deposit and decrement vault TVL.
          const deposit = await DepositModel.findById(request.depositId);
          if (deposit && deposit.status !== 'withdrawn') {
            await DepositModel.findByIdAndUpdate(request.depositId, { status: 'withdrawn', withdrawnAt: new Date() });
            await VaultModel.findByIdAndUpdate(deposit.vaultId, { $inc: { totalStaked: -deposit.amount, totalUsers: -1 } });

            // On-chain deposit mirror: burn the principal so the mirror reflects CURRENT total.
            void burnForWithdrawal(deposit.amount, String(deposit._id));

            // On-chain registry: if the user now has NO active/matured deposits, deregister them.
            const remaining = await DepositModel.countDocuments({ userId: uid, status: { $in: ['active', 'matured'] } });
            if (remaining === 0) {
              const u: any = await UserModel.findById(uid).select('walletAddress');
              if (u?.walletAddress) void deregisterUserOnChain(u.walletAddress);
            }
          }
        } else if (request.source === 'yield' && request.depositId) {
          // Per-deposit yield: now mark it withdrawn against that deposit.
          await DepositModel.findByIdAndUpdate(request.depositId, { $inc: { yieldWithdrawn: request.amount } });
        } else if (request.source === 'yield') {
          // Aggregate yield: now debit the yield wallet.
          const f = request.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
          await UserModel.findByIdAndUpdate(uid, { $inc: { [f]: -request.amount } });
        } else if (request.source === 'referral') {
          await UserModel.findByIdAndUpdate(uid, { $inc: { referralEarnings: -request.amount } });
        }

        await ActivityModel.create({ adminId: this.adminId, title: 'Withdrawal Approved', type: 'admin', metadata: { requestId, amount: request.amount, fee: (request as any).fee || 0, netPaid: netPayout, txHash: finalTxHash } });
        return { data: { txHash: finalTxHash, netPaid: netPayout, fee: (request as any).fee || 0 }, error: null, message: 'Withdrawal approved', status: 200 };
      } else {
        // REJECT: nothing was ever deducted at submit time, so there is nothing to refund —
        // every balance stays exactly as it was. Just mark the request rejected.
        await WithdrawRequestModel.findByIdAndUpdate(requestId, { status: 'rejected', reviewedBy: this.adminId, reviewNote: note || '' });
        await ActivityModel.create({ adminId: this.adminId, title: 'Withdrawal Rejected', type: 'admin', metadata: { requestId, amount: request.amount } });
        return { data: null, error: null, message: 'Withdrawal rejected', status: 200 };
      }
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── APY DISTRIBUTION (manual trigger) ──
  async triggerAPYDistribution(): Promise<IResponse> {
    try {
      const result = await distributeMonthlyAPY();
      await ActivityModel.create({ adminId: this.adminId, title: 'APY Distribution Triggered', type: 'admin', metadata: result });
      return { data: result, error: null, message: 'APY distribution completed', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Distribution failed', status: 500 };
    }
  }

  // ── YIELD LOGS ──
  async getYieldLogs(page = 1, limit = 20, source?: string): Promise<IResponse> {
    try {
      const query: any = {};
      if (source) query.source = source;
      const skip = (page - 1) * limit;
      const [logs, total] = await Promise.all([
        YieldLogModel.find(query).populate('userId', 'name email').populate('vaultId', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit),
        YieldLogModel.countDocuments(query),
      ]);
      return { data: { logs, total, page, limit }, error: null, message: 'Yield logs', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── ACTIVITY LOGS ──
  async getActivityLogs(page = 1, limit = 50): Promise<IResponse> {
    try {
      const skip = (page - 1) * limit;
      const [logs, total] = await Promise.all([
        ActivityModel.find().populate('userId', 'name email').populate('adminId', 'name email').sort({ createdAt: -1 }).skip(skip).limit(limit),
        ActivityModel.countDocuments(),
      ]);
      return { data: { logs, total, page, limit }, error: null, message: 'Activity logs', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── REFERRAL STATS ──
  async getReferralStats(): Promise<IResponse> {
    try {
      const topReferrers = await UserModel.find({ referralEarnings: { $gt: 0 } })
        .select('name email referralCode referralEarnings totalDeposited')
        .sort({ referralEarnings: -1 }).limit(20);

      const totalReferralPaid = await YieldLogModel.aggregate([
        { $match: { source: { $in: ['referral_l1', 'referral_l2'] } } },
        { $group: { _id: '$source', total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]);

      return { data: { topReferrers, totalReferralPaid }, error: null, message: 'Referral stats', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── FINANCIAL OVERVIEW ──
  // A single, reconcilable view of every money flow: yield generated → matured (withdrawable)
  // → withdrawn, plus live (un-matured) yield still accruing, and full principal movement.
  async getFinancialOverview(): Promise<IResponse> {
    try {
      const r6 = (n: any) => Math.round(Number(n || 0) * 1e6) / 1e6;
      const sum = (arr: any[]) => (arr?.[0]?.total || 0);

      const [
        yieldGenerated,            // all matured yield ever recognised (YieldLog vault_apy)
        referralGenerated,         // all referral commissions ever paid out (YieldLog referral_*)
        walletBalances,            // matured yield sitting in user wallets (withdrawable, not yet withdrawn)
        referralOutstanding,       // referral earnings not yet withdrawn
        yieldWithdrawnAgg,         // completed yield withdrawals (gross + net paid + fees)
        referralWithdrawnAgg,      // completed referral withdrawals
        principalRedeemedAgg,      // completed principal redemptions (gross + net + fees + early count)
        pendingByType,             // pending withdrawals grouped by source
        activePrincipalAgg,        // principal still staked (active + matured deposits)
        allDepositedAgg,           // all-time deposited principal
        depositsByStatus,          // deposit counts by status
        activeDeposits,            // for live (un-matured) yield computation
      ] = await Promise.all([
        YieldLogModel.aggregate([{ $match: { source: 'vault_apy' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
        YieldLogModel.aggregate([{ $match: { source: { $in: ['referral_l1', 'referral_l2'] } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
        UserModel.aggregate([{ $group: { _id: null, usdt: { $sum: '$yieldWalletUSDT' }, usdc: { $sum: '$yieldWalletUSDC' } } }]),
        UserModel.aggregate([{ $group: { _id: null, total: { $sum: '$referralEarnings' } } }]),
        WithdrawRequestModel.aggregate([{ $match: { source: 'yield', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$amount' }, net: { $sum: '$netAmount' }, fees: { $sum: '$fee' }, count: { $sum: 1 } } }]),
        WithdrawRequestModel.aggregate([{ $match: { source: 'referral', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$amount' }, net: { $sum: '$netAmount' }, count: { $sum: 1 } } }]),
        WithdrawRequestModel.aggregate([{ $match: { source: 'deposit', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$amount' }, net: { $sum: '$netAmount' }, fees: { $sum: '$fee' }, count: { $sum: 1 }, earlyCount: { $sum: { $cond: ['$early', 1, 0] } } } }]),
        WithdrawRequestModel.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: '$source', gross: { $sum: '$amount' }, count: { $sum: 1 } } }]),
        DepositModel.aggregate([{ $match: { status: { $in: ['active', 'matured'] } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
        DepositModel.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
        DepositModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
        DepositModel.find({ status: 'active' }).select('amount apyPercent createdAt').lean(),
      ]);

      // Live, un-matured yield across every active deposit (accruing in the current 30-day cycle).
      let liveAccruing = 0;
      for (const d of activeDeposits as any[]) liveAccruing += computeLiveCycleYield(d);

      const wallet = walletBalances?.[0] || { usdt: 0, usdc: 0 };
      const maturedOutstanding = Number(wallet.usdt || 0) + Number(wallet.usdc || 0);

      const pending: any = { yield: { gross: 0, count: 0 }, deposit: { gross: 0, count: 0 }, referral: { gross: 0, count: 0 } };
      for (const p of pendingByType as any[]) if (pending[p._id]) pending[p._id] = { gross: r6(p.gross), count: p.count };

      const yw = yieldWithdrawnAgg?.[0] || {};
      const rw = referralWithdrawnAgg?.[0] || {};
      const pr = principalRedeemedAgg?.[0] || {};

      return {
        data: {
          generatedAt: new Date().toISOString(),
          yield: {
            generatedAllTime: r6(sum(yieldGenerated)),      // total matured yield ever
            maturationEvents: yieldGenerated?.[0]?.count || 0,
            maturedOutstanding: r6(maturedOutstanding),      // matured, withdrawable, not yet withdrawn
            maturedOutstandingByAsset: { USDT: r6(wallet.usdt), USDC: r6(wallet.usdc) },
            liveAccruing: r6(liveAccruing),                  // un-matured, not yet withdrawable
            withdrawnGross: r6(yw.gross), withdrawnNet: r6(yw.net), withdrawnCount: yw.count || 0,
            pendingWithdrawal: pending.yield,
          },
          referral: {
            generatedAllTime: r6(sum(referralGenerated)),
            outstanding: r6(sum(referralOutstanding)),
            withdrawnGross: r6(rw.gross), withdrawnNet: r6(rw.net), withdrawnCount: rw.count || 0,
            pendingWithdrawal: pending.referral,
          },
          principal: {
            activeStaked: r6(sum(activePrincipalAgg)), activeCount: activePrincipalAgg?.[0]?.count || 0,
            allTimeDeposited: r6(sum(allDepositedAgg)),
            redeemedGross: r6(pr.gross), redeemedNet: r6(pr.net), redeemedCount: pr.count || 0,
            earlyExitCount: pr.earlyCount || 0, earlyExitFees: r6(pr.fees),
            pendingRedemption: pending.deposit,
            byStatus: (depositsByStatus as any[]).reduce((acc, s) => { acc[s._id] = { count: s.count, amount: r6(s.amount) }; return acc; }, {} as any),
          },
          feesCollected: r6(Number(pr.fees || 0)),           // all early-exit fees retained by treasury
        },
        error: null, message: 'Financial overview', status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }
}