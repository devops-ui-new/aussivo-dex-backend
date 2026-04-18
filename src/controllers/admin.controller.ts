import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import AdminModel from '../models/admin.model';
import UserModel from '../models/user.model';
import VaultModel from '../models/vault.model';
import DepositModel from '../models/deposit.model';
import YieldLogModel from '../models/yieldLog.model';
import WithdrawRequestModel from '../models/withdrawRequest.model';
import ActivityModel from '../models/activity.model';
import { JWT_SECRET } from '../configs/constants';
import { IResponse } from '../utils/response.util';
import { distributeMonthlyAPY } from '../helpers/apyDistribution.helper';
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
      const [totalUsers, totalDeposits, activeVaults, totalTVL, pendingWithdrawals, totalYieldDistributed, recentDeposits] = await Promise.all([
        UserModel.countDocuments({ status: 'active' }),
        DepositModel.countDocuments(),
        VaultModel.countDocuments({ status: 'active' }),
        VaultModel.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$totalStaked' } } }]),
        WithdrawRequestModel.countDocuments({ status: 'pending' }),
        YieldLogModel.aggregate([{ $match: { source: 'vault_apy' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        DepositModel.find().populate('userId', 'name email').populate('vaultId', 'name').sort({ createdAt: -1 }).limit(10),
      ]);

      return {
        data: {
          totalUsers, totalDeposits, activeVaults,
          totalTVL: totalTVL[0]?.total || 0,
          pendingWithdrawals,
          totalYieldDistributed: totalYieldDistributed[0]?.total || 0,
          recentDeposits,
        },
        error: null, message: 'Dashboard data', status: 200
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
        DepositModel.find(query).populate('userId', 'name email walletAddress').populate('vaultId', 'name asset').sort({ createdAt: -1 }).skip(skip).limit(limit),
        DepositModel.countDocuments(query),
      ]);
      return { data: { deposits, total, page, limit }, error: null, message: 'All deposits', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── MANUAL DEPOSIT (admin confirms on-chain deposit) ──
  async confirmDeposit(body: { userId: string; vaultId: string; amount: number; txHash?: string }): Promise<IResponse> {
    try {
      const { userId, vaultId, amount, txHash } = body;
      const user = await UserModel.findById(userId);
      if (!user) return { data: null, error: 'User not found', message: 'User not found', status: 404 };

      const vault = await VaultModel.findById(vaultId);
      if (!vault) return { data: null, error: 'Vault not found', message: 'Vault not found', status: 404 };

      let tierIndex = 0;
      let apyPercent = vault.tiers[0]?.apyPercent || 0;
      for (let i = vault.tiers.length - 1; i >= 0; i--) {
        if (amount >= vault.tiers[i].minAmount) { tierIndex = i; apyPercent = vault.tiers[i].apyPercent; break; }
      }

      const lockUntil = vault.lockDays > 0 ? new Date(Date.now() + vault.lockDays * 86400000) : null;
      const deposit = await DepositModel.create({
        userId, vaultId, amount, asset: vault.asset, txHash: txHash || '',
        walletAddress: user.walletAddress, lockUntil, apyPercent, tierIndex,
        maxYieldPayments: vault.durationMonths, status: 'active',
      });

      await VaultModel.findByIdAndUpdate(vaultId, { $inc: { totalStaked: amount, totalUsers: 1 } });
      const balField = vault.asset === 'USDT' ? 'usdtBalance' : 'usdcBalance';
      await UserModel.findByIdAndUpdate(userId, { $inc: { [balField]: amount, totalDeposited: amount } });

      await ActivityModel.create({ adminId: this.adminId, title: 'Deposit Confirmed', description: `Admin confirmed $${amount} ${vault.asset} deposit for ${user.email}`, type: 'admin' });
      return { data: deposit, error: null, message: 'Deposit confirmed', status: 201 };
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
        await WithdrawRequestModel.findByIdAndUpdate(requestId, {
          status: 'completed', txHash: txHash || '', reviewedBy: this.adminId, reviewNote: note || ''
        });
        await UserModel.findByIdAndUpdate(request.userId, { $inc: { totalWithdrawn: request.amount } });
      } else {
        // Refund balance
        let balanceField = '';
        if (request.source === 'yield') balanceField = request.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
        else if (request.source === 'referral') balanceField = 'referralEarnings';
        if (balanceField) await UserModel.findByIdAndUpdate(request.userId, { $inc: { [balanceField]: request.amount } });
        await WithdrawRequestModel.findByIdAndUpdate(requestId, { status: 'rejected', reviewedBy: this.adminId, reviewNote: note || '' });
      }

      await ActivityModel.create({ adminId: this.adminId, title: `Withdrawal ${action === 'approve' ? 'Approved' : 'Rejected'}`, type: 'admin', metadata: { requestId, amount: request.amount } });
      return { data: null, error: null, message: `Withdrawal ${action}d`, status: 200 };
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
}
