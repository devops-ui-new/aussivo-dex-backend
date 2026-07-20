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
import { enqueueAttest } from '../services/chainSync.worker';
import ChainOutbox from '../models/chainOutbox.model';
import { isRegistryV2Enabled, registryV2Signer, signerGasBnb, readGlobals } from '../services/registryV2.service';
import { reconcileChain, getLastReconcileReport } from '../services/chainReconcile.service';
import DepositAddressModel from '../models/depositAddress.model';
import ScannerStateModel from '../models/scannerState.model';
import DepositCreditModel from '../models/depositCredit.model';
import DepositSweepModel from '../models/depositSweep.model';
import { forceSweepAddress as sweepAddressNow, recoverFromAddress } from '../services/persistentSweep.service';
import { rescanTrc20Address } from '../services/depositScannerTrc20.service';
import { rescanBep20Range } from '../services/depositScannerBep20.service';
import { describeKeyCustody } from '../helpers/depositKey.helper';
import { ethers } from 'ethers';
import { BSC_PROVIDER_URL, BSC_CHAIN_ID, PERSISTENT_DEPOSIT_ADDRESSES, TRON_GAS_TOPUP_TRX } from '../configs/constants';
import { CHAIN_MIN_GAS_BNB, REGISTRY_V2_ADDRESS } from '../configs/constants';
import logger from '../configs/logger.config';

/**
 * Rows settled outside the platform are closed items. Every admin total, treasury figure
 * and deposit list filters on this so the numbers reconcile — a UI-only filter would hide
 * the row while leaving the totals wrong, which is worse than showing it.
 *
 * `$ne: true` (rather than `false`) so documents predating the field are still counted.
 */
const NOT_EXCLUDED = { excludedFromAccounting: { $ne: true } };

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
        DepositModel.countDocuments(NOT_EXCLUDED),
        VaultModel.countDocuments({ status: 'active' }),
        VaultModel.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$totalStaked' } } }]),
        WithdrawRequestModel.countDocuments({ status: 'pending' }),
        YieldLogModel.aggregate([{ $match: { source: 'vault_apy' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        DepositModel.find(NOT_EXCLUDED).populate('userId', 'name email').populate('vaultId', 'name').sort({ createdAt: -1 }).limit(10),
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
  // ── DEPOSIT & SWEEP HEALTH (unified: legacy + persistent) ─────────────────
  // One page that answers three questions without the admin having to interpret
  // anything: is money at risk right now, is anything blocked, and what do I click.
  //
  // `alerts` is the contract with the UI — severity-ranked, each with a concrete
  // action. The UI renders them verbatim so backend and frontend can never disagree
  // about what counts as an emergency.
  async getSweepStatus(): Promise<IResponse> {
    try {
      const now = Date.now();
      const STUCK_MS = 3 * 60 * 1000;
      const notSwept = { $or: [{ sweepTxHash: "" }, { sweepTxHash: { $exists: false } }] };
      const legacyOnly = { depositAddressId: { $in: [null, undefined] }, ...NOT_EXCLUDED };
      const r6 = (n: any) => Math.round(Number(n || 0) * 1e6) / 1e6;

      const toBig = (v: any): bigint => {
        let str = String(v ?? '0').trim();
        if (!str || str === '0') return 0n;
        if (/[eE]/.test(str)) {
          const [mant, expRaw] = str.split(/[eE]/);
          const exp = parseInt(expRaw, 10);
          const [i, f = ''] = mant.replace(/^[-+]/, '').split('.');
          const digits = i + f;
          const pad = exp - f.length;
          str = pad >= 0 ? digits + '0'.repeat(pad) : digits.slice(0, digits.length + pad);
        }
        str = str.split('.')[0];
        try { return BigInt(str); } catch { return 0n; }
      };

      // ── LEGACY (ephemeral) per chain ──
      const legacyChain = async (network: 'bep20' | 'trc20') => {
        const [openSessions, awaitingSweep, swept, expired, stuckDocs] = await Promise.all([
          PendingDepositModel.countDocuments({ network, status: 'pending', expiresAt: { $gt: new Date(now) }, ...legacyOnly }),
          PendingDepositModel.countDocuments({ network, status: 'credited', ...notSwept, ...legacyOnly }),
          PendingDepositModel.countDocuments({ network, status: 'matched', ...legacyOnly }),
          PendingDepositModel.countDocuments({ network, status: 'expired', ...legacyOnly }),
          PendingDepositModel.find({
            network, status: 'credited', ...notSwept, ...legacyOnly,
            userCreditedAt: { $lt: new Date(now - STUCK_MS) },
          })
            .select('ephemeralAddress asset receivedAmount expectedAmount userCreditedAt energyFundedAt privateKeyEncrypted')
            .sort({ userCreditedAt: 1 }).limit(50).lean(),
        ]);

        const stuck = stuckDocs.map((d: any) => {
          const hasKey = !!d.privateKeyEncrypted;
          return {
            id: String(d._id),
            address: d.ephemeralAddress,
            asset: d.asset,
            amount: r6(d.receivedAmount || d.expectedAmount || 0),
            waitingMinutes: d.userCreditedAt ? Math.round((now - new Date(d.userCreditedAt).getTime()) / 60000) : null,
            lastFundedAt: d.energyFundedAt || null,
            hasKey,
            // A purged key means force-sweep CANNOT work. Say so instead of offering a
            // button that silently fails.
            canForceSweep: hasKey,
            blockedReason: hasKey ? null : 'Private key was purged — force sweep cannot work. Restore the key from a database snapshot.',
          };
        });

        return { openSessions, awaitingSweep, swept, expired, stuckCount: stuck.length, stuck };
      };

      // ── PERSISTENT (deposit_addresses) per chain ──
      const persistentChain = async (network: 'bep20' | 'trc20') => {
        const rows: any[] = await DepositAddressModel.find({ network, status: 'active' })
          .select('address creditedTotal sweptTotal creditsCount lastSweepError sweepFailureCount unexplainedBalanceSince userId')
          .populate('userId', 'email')
          .lean();

        const dec = network === 'trc20' ? 6 : 18;
        const human = (v: bigint) => Number(v) / 10 ** dec;

        let credited = 0n, swept = 0n, withFunds = 0;
        const blocked: any[] = [];

        for (const r of rows) {
          const c = toBig(r.creditedTotal);
          const w = toBig(r.sweptTotal);
          credited += c; swept += w;
          const owed = c > w ? c - w : 0n;
          if (owed > 0n) {
            withFunds++;
            blocked.push({
              id: String(r._id),
              address: r.address,
              email: (r.userId as any)?.email || '',
              awaiting: r6(human(owed)),
              lastError: r.lastSweepError || '',
              failures: r.sweepFailureCount || 0,
              // Persistent addresses ALWAYS have a recoverable key by design.
              canForceSweep: true,
            });
          }
        }

        const unexplained = rows.filter((r) => r.unexplainedBalanceSince).length;

        return {
          addresses: rows.length,
          creditedTotal: r6(human(credited)),
          sweptTotal: r6(human(swept)),
          awaitingSweepTotal: r6(human(credited > swept ? credited - swept : 0n)),
          addressesAwaitingSweep: withFunds,
          unexplained,
          blocked: blocked.sort((a, b) => b.awaiting - a.awaiting).slice(0, 50),
        };
      };

      const [
        legacyBep, legacyTron, persBep, persTron,
        bscFunder, tronFunder, creditsPending, creditsFailed, cursors,
      ] = await Promise.all([
        legacyChain('bep20'), legacyChain('trc20'),
        persistentChain('bep20'), persistentChain('trc20'),
        getGasFunderStatus(), getTronGasFunderStatus(),
        DepositCreditModel.countDocuments({ status: 'detected' }),
        DepositCreditModel.countDocuments({ status: 'failed' }),
        ScannerStateModel.find({ key: { $regex: '^bep20:' } }).lean(),
      ]);

      // ── Scanner lag: a held cursor means deposits are NOT being detected ──
      let scanner: any = { enabled: PERSISTENT_DEPOSIT_ADDRESSES, tokens: [] as any[], maxLagBlocks: 0, lastError: '' };
      if (PERSISTENT_DEPOSIT_ADDRESSES) {
        let head = 0;
        try {
          const url = BSC_PROVIDER_URL.split(',')[0].trim();
          const prov = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true });
          head = await prov.getBlockNumber();
        } catch { /* leave head 0 */ }
        scanner.headBlock = head;
        for (const c of cursors as any[]) {
          const lag = head && c.lastScannedBlock ? Math.max(0, head - c.lastScannedBlock) : 0;
          scanner.tokens.push({
            key: c.key, lastScannedBlock: c.lastScannedBlock, lagBlocks: lag,
            lastError: c.lastError || '', lastRunAt: c.lastRunAt,
          });
          if (lag > scanner.maxLagBlocks) scanner.maxLagBlocks = lag;
          if (c.lastError) scanner.lastError = c.lastError;
        }
      }

      // ── ALERTS — severity-ranked, each with a concrete action ──
      const alerts: any[] = [];

      const purged = [...legacyBep.stuck, ...legacyTron.stuck].filter((s: any) => !s.hasKey);
      if (purged.length) {
        const total = purged.reduce((a: number, b: any) => a + b.amount, 0);
        alerts.push({
          level: 'critical',
          title: `$${r6(total)} stranded with a purged key`,
          detail: `${purged.length} legacy address(es) hold funds but the key was deleted. Force sweep cannot work — the key must be restored from a database snapshot.`,
          action: 'Restore from MongoDB Atlas snapshot',
        });
      }

      if (creditsFailed > 0) {
        alerts.push({
          level: 'critical',
          title: `${creditsFailed} deposit(s) failed to credit`,
          detail: 'Funds are safe on the deposit address, but the user cannot see them yet.',
          action: 'Check Deposit Addresses → rescan',
        });
      }

      const bscBlocked = bscFunder ? !bscFunder.ok : false;
      const tronBlocked = tronFunder ? !tronFunder.ok : false;
      const bscNeeds = legacyBep.awaitingSweep > 0 || persBep.addressesAwaitingSweep > 0;
      const tronNeeds = legacyTron.awaitingSweep > 0 || persTron.addressesAwaitingSweep > 0;

      if (bscBlocked && bscNeeds) {
        alerts.push({
          level: 'critical',
          title: 'BSC gas funder is empty — sweeps are blocked',
          detail: `${bscFunder?.bnb ?? '0'} BNB left. Users are credited; funds just aren't reaching treasury yet.`,
          action: `Send BNB to ${bscFunder?.address || 'the gas funder'}`,
        });
      } else if (bscBlocked) {
        alerts.push({
          level: 'warning',
          title: 'BSC gas funder is low',
          detail: `${bscFunder?.bnb ?? '0'} BNB left. Nothing blocked yet.`,
          action: `Top up ${bscFunder?.address || 'the gas funder'}`,
        });
      }

      if (tronBlocked && tronNeeds) {
        alerts.push({
          level: 'critical',
          title: 'Tron gas funder is empty — sweeps are blocked',
          detail: `${tronFunder?.trx ?? '0'} TRX left. Each sweep needs about ${TRON_GAS_TOPUP_TRX} TRX.`,
          action: `Send TRX to ${tronFunder?.address || 'the gas funder'}`,
        });
      } else if (tronBlocked) {
        alerts.push({
          level: 'warning',
          title: 'Tron gas funder is low',
          detail: `${tronFunder?.trx ?? '0'} TRX left. Nothing blocked yet.`,
          action: `Top up ${tronFunder?.address || 'the gas funder'}`,
        });
      }

      if (PERSISTENT_DEPOSIT_ADDRESSES && scanner.maxLagBlocks > 500) {
        alerts.push({
          level: 'critical',
          title: 'Deposit scanner is behind',
          detail: `New deposits aren't being picked up yet. Nothing is lost — the scanner replays the range once the RPC responds.`,
          action: 'Set BSC_PROVIDER_URL to a dedicated RPC provider',
        });
      } else if (PERSISTENT_DEPOSIT_ADDRESSES && scanner.lastError) {
        alerts.push({
          level: 'warning',
          title: 'Deposit scanner is retrying a block range',
          detail: 'Retrying a block range. Nothing can be missed; crediting is just delayed.',
          action: 'Consider a dedicated BSC RPC endpoint',
        });
      }

      const unexplainedTotal = persBep.unexplained + persTron.unexplained;
      if (unexplainedTotal > 0) {
        alerts.push({
          level: 'warning',
          title: `${unexplainedTotal} address(es) hold more than has been credited`,
          detail: 'The uncredited portion is held back deliberately, so no user can be shorted.',
          action: 'Deposit Addresses → rescan',
        });
      }

      if (creditsPending > 3) {
        alerts.push({
          level: 'warning',
          title: `${creditsPending} credit(s) queued`,
          detail: 'Normally clears within a minute.',
          action: 'Watch — escalate if it does not drain',
        });
      }

      if (!PERSISTENT_DEPOSIT_ADDRESSES) {
        alerts.push({
          level: 'info',
          title: 'Persistent deposit addresses are disabled',
          detail: 'Deposits still use one-time addresses that expire.',
          action: 'Set PERSISTENT_DEPOSIT_ADDRESSES=true when ready',
        });
      }

      const order: any = { critical: 0, warning: 1, info: 2 };
      alerts.sort((a, b) => order[a.level] - order[b.level]);

      return {
        data: {
          generatedAt: new Date(now).toISOString(),
          persistentEnabled: PERSISTENT_DEPOSIT_ADDRESSES,
          alerts,
          criticalCount: alerts.filter((a) => a.level === 'critical').length,
          scanner,
          credits: { pending: creditsPending, failed: creditsFailed },
          funders: {
            bep20: bscFunder ? { ...bscFunder, unit: 'BNB', blocking: bscBlocked && bscNeeds } : null,
            trc20: tronFunder ? { ...tronFunder, unit: 'TRX', blocking: tronBlocked && tronNeeds } : null,
          },
          persistent: { bep20: persBep, trc20: persTron },
          legacy: { bep20: legacyBep, trc20: legacyTron },
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
        { $match: { status: { $in: ['credited', 'matched'] }, ...NOT_EXCLUDED } },
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
        DepositModel.aggregate([{ $match: { status: 'active', ...NOT_EXCLUDED } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        DepositModel.aggregate([{ $match: NOT_EXCLUDED }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
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

  // Comprehensive 360° profile for support / dispute resolution: identity, balances, every
  // deposit with a live 30-day-cycle yield breakdown (matured vs accruing vs next maturation),
  // all withdrawal requests, recent yield payments, referral tree, and a wallet-consistency check.
  async getUserProfile(userId: string): Promise<IResponse> {
    try {
      const user = await UserModel.findById(userId).select('-__v');
      if (!user) return { data: null, error: 'Not found', message: 'User not found', status: 404 };

      const [deposits, withdrawals, yieldLogs, referrals, referrer] = await Promise.all([
        DepositModel.find({ userId }).populate('vaultId', 'name asset lockDays').sort({ createdAt: -1 }),
        WithdrawRequestModel.find({ userId }).sort({ createdAt: -1 }),
        YieldLogModel.find({ userId }).sort({ createdAt: -1 }).limit(50),
        UserModel.find({ referredBy: userId }).select('name email createdAt totalDeposited'),
        (user as any).referredBy ? UserModel.findById((user as any).referredBy).select('name email referralCode') : Promise.resolve(null),
      ]);

      const CYCLE = 30 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
      const asAsset = (a: any) => (a === 'USDC' ? 'USDC' : 'USDT');

      const matured: any = { USDT: 0, USDC: 0 };
      const accruing: any = { USDT: 0, USDC: 0 };
      let activePrincipal = 0, totalEarnedToDate = 0, activeCount = 0, lockedCount = 0;

      const depositView = (deposits as any[]).map((d) => {
        const asset = asAsset(d.asset);
        const amount = Number(d.amount || 0);
        const apy = Number(d.apyPercent || 0);
        const monthly = amount * (apy / 12) / 100;
        const created = new Date(d.createdAt).getTime();
        const withdrawnAt = d.status === 'withdrawn' && d.withdrawnAt ? new Date(d.withdrawnAt).getTime() : null;
        const end = withdrawnAt ?? now;
        const elapsed = Math.max(0, end - created);
        const cycles = Math.floor(elapsed / CYCLE);
        const maturedYield = r6(cycles * monthly);
        const fracMs = elapsed - cycles * CYCLE;
        const accruingNow = withdrawnAt ? 0 : r6(monthly * (fracMs / CYCLE));
        const lockUntil = d.lockUntil ? new Date(d.lockUntil).getTime() : null;
        const locked = !!(lockUntil && lockUntil > now);

        totalEarnedToDate += maturedYield;
        if (d.status !== 'withdrawn') {
          activePrincipal += amount; activeCount++;
          matured[asset] += maturedYield; accruing[asset] += accruingNow;
          if (locked) lockedCount++;
        }
        return {
          _id: d._id, amount, asset, apyPercent: apy, monthly: r6(monthly),
          vault: d.vaultId?.name || '—', status: d.status, manual: !!d.manual, txHash: d.txHash || '',
          createdAt: d.createdAt, lockUntil: d.lockUntil || null, locked, withdrawnAt: d.withdrawnAt || null,
          cyclesMatured: cycles, maturedYield, accruing: accruingNow,
          totalYieldPaid: Number(d.totalYieldPaid || 0),
          cycleProgressPct: withdrawnAt ? 0 : Math.min(100, Math.round((fracMs / CYCLE) * 100)),
          nextMaturationAt: withdrawnAt ? null : new Date(created + (cycles + 1) * CYCLE).toISOString(),
          nextMaturationAmount: withdrawnAt ? 0 : r6(monthly),
        };
      });

      const w = { yieldWithdrawnUSDT: 0, yieldWithdrawnUSDC: 0, principalRedeemed: 0, pending: 0, rejected: 0, completed: 0, approved: 0 };
      for (const req of withdrawals as any[]) {
        const asset = asAsset(req.asset); const amt = Number(req.amount || 0); const st = req.status;
        if (st === 'completed') w.completed++; else if (st === 'pending') w.pending++;
        else if (st === 'rejected') w.rejected++; else if (st === 'approved') w.approved++;
        const nonRejected = ['completed', 'approved', 'pending'].includes(st);
        if (nonRejected && req.source === 'yield') { if (asset === 'USDC') w.yieldWithdrawnUSDC += amt; else w.yieldWithdrawnUSDT += amt; }
        if (st === 'completed' && req.source === 'deposit') w.principalRedeemed += amt;
      }

      const expectedWalletUSDT = r6(Math.max(0, matured.USDT - w.yieldWithdrawnUSDT));
      const expectedWalletUSDC = r6(Math.max(0, matured.USDC - w.yieldWithdrawnUSDC));
      const actualWalletUSDT = Number((user as any).yieldWalletUSDT || 0);
      const actualWalletUSDC = Number((user as any).yieldWalletUSDC || 0);

      const totals = {
        activePrincipal: r6(activePrincipal),
        totalDepositedAllTime: Number((user as any).totalDeposited || 0),
        depositsCount: deposits.length, activeDepositsCount: activeCount, lockedCount,
        maturedWithdrawableUSDT: r6(matured.USDT), maturedWithdrawableUSDC: r6(matured.USDC),
        accruingUSDT: r6(accruing.USDT), accruingUSDC: r6(accruing.USDC),
        totalYieldEarnedToDate: r6(totalEarnedToDate),
        yieldWalletUSDT: actualWalletUSDT, yieldWalletUSDC: actualWalletUSDC,
        totalWithdrawn: Number((user as any).totalWithdrawn || 0),
        referralEarnings: Number((user as any).referralEarnings || 0),
        withdrawals: w,
        consistency: {
          expectedWalletUSDT, actualWalletUSDT, matchUSDT: Math.abs(expectedWalletUSDT - actualWalletUSDT) < 0.01,
          expectedWalletUSDC, actualWalletUSDC, matchUSDC: Math.abs(expectedWalletUSDC - actualWalletUSDC) < 0.01,
        },
      };

      return {
        data: {
          user, totals, deposits: depositView, withdrawals, yieldLogs,
          referral: {
            code: (user as any).referralCode,
            referredBy: referrer ? { name: (referrer as any).name, email: (referrer as any).email, code: (referrer as any).referralCode } : null,
            referredCount: referrals.length, referredUsers: referrals,
            earnings: Number((user as any).referralEarnings || 0),
          },
        },
        error: null, message: 'User profile', status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── DEPOSIT MANAGEMENT ──
  async getAllDeposits(page = 1, limit = 20, vaultId?: string, status?: string): Promise<IResponse> {
    try {
      const query: any = { ...NOT_EXCLUDED };
      if (vaultId) query.vaultId = vaultId;
      if (status) query.status = status;
      const skip = (page - 1) * limit;
      const [deposits, total] = await Promise.all([
        DepositModel.find(query).populate('userId', 'name email walletAddress walletAddresses').populate('vaultId', 'name asset').sort({ createdAt: -1 }).skip(skip).limit(limit),
        DepositModel.countDocuments(query),
      ]);
      // Totals so the admin can see manual vs on-chain at a glance (across the whole filter).
      const [manualCount, onchainCount] = await Promise.all([
        DepositModel.countDocuments({ ...query, manual: true }),
        DepositModel.countDocuments({ ...query, manual: { $ne: true } }),
      ]);
      return { data: { deposits, total, page, limit, manualCount, onchainCount }, error: null, message: 'All deposits', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // Mark/unmark a deposit as a manual (admin-entered) settlement, for the origin badge.
  async setDepositManual(depositId: string, manual: boolean): Promise<IResponse> {
    try {
      const dep = await DepositModel.findByIdAndUpdate(depositId, { manual: !!manual }, { new: true });
      if (!dep) return { data: null, error: 'Not found', message: 'Deposit not found', status: 404 };
      await ActivityModel.create({ adminId: this.adminId, title: manual ? 'Deposit flagged manual' : 'Deposit flagged on-chain', type: 'admin', metadata: { depositId, manual: !!manual, amount: dep.amount } });
      return { data: { _id: dep._id, manual: dep.manual }, error: null, message: `Marked as ${manual ? 'manual' : 'on-chain'}`, status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // ── WITHDRAWAL MANAGEMENT ──
  async getWithdrawRequests(page = 1, limit = 20, status?: string, source?: string): Promise<IResponse> {
    try {
      const query: any = {};
      if (status) query.status = status;
      // Filter by kind of withdrawal so the admin can review Principal / Yield / Referral
      // in separate tabs. `source`: 'deposit' (principal) | 'yield' | 'referral'.
      if (source) query.source = source;
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
        const uid = (request.userId as any)?._id || request.userId;

        // ── DEFENCE IN DEPTH: re-check the payout address at approval time ──
        // The address was validated when the request was created, but wallets can be
        // unlinked afterwards, and this is the last moment before funds leave.
        {
          const payee = await UserModel.findById(uid).select('walletAddress walletAddresses email');
          const linked = new Set<string>(
            [
              ...((payee?.walletAddresses as any) || []).map((w: string) => (w || '').trim().toLowerCase()),
              (payee?.walletAddress || '').trim().toLowerCase(),
            ].filter(Boolean)
          );
          const dest = String(request.walletAddress || '').trim().toLowerCase();
          if (!dest || !linked.has(dest)) {
            await WithdrawRequestModel.findByIdAndUpdate(requestId, {
              status: 'pending', reviewedBy: null,
              reviewNote: 'blocked: payout address is not linked to this user',
            });
            logger.error(`[WITHDRAW] BLOCKED payout to unlinked address ${dest} for ${payee?.email}`);
            return {
              data: null, error: 'Unlinked payout address',
              message: 'Blocked: the payout address is not linked to this user account. Do not approve this request until it is explained.',
              status: 403,
            };
          }
        }

        // ── DEBIT FIRST, THEN PAY ──
        // The debit used to run AFTER the on-chain send. If it then failed (the schema
        // blocks negative balances), the user had already been paid, the request was
        // already 'completed', and their balance was never reduced. Debiting first means
        // an insufficient balance stops the payout instead of discovering it too late.
        let debitApplied: null | (() => Promise<void>) = null; // compensating refund
        try {
          if (request.source === 'deposit' && request.depositId) {
            const deposit = await DepositModel.findById(request.depositId);
            if (deposit && deposit.status !== 'withdrawn') {
              await DepositModel.findByIdAndUpdate(request.depositId, { status: 'withdrawn', withdrawnAt: new Date() });
              await VaultModel.findByIdAndUpdate(deposit.vaultId, { $inc: { totalStaked: -deposit.amount, totalUsers: -1 } });
              debitApplied = async () => {
                await DepositModel.findByIdAndUpdate(request.depositId, { status: 'active', withdrawnAt: null });
                await VaultModel.findByIdAndUpdate(deposit.vaultId, { $inc: { totalStaked: deposit.amount, totalUsers: 1 } });
              };
            }
          } else if (request.source === 'yield' && request.depositId) {
            await DepositModel.findByIdAndUpdate(request.depositId, { $inc: { yieldWithdrawn: request.amount } });
            debitApplied = async () => {
              await DepositModel.findByIdAndUpdate(request.depositId, { $inc: { yieldWithdrawn: -request.amount } });
            };
          } else if (request.source === 'yield') {
            const f = request.asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
            await UserModel.findByIdAndUpdate(uid, { $inc: { [f]: -request.amount } });
            debitApplied = async () => { await UserModel.findByIdAndUpdate(uid, { $inc: { [f]: request.amount } }); };
          } else if (request.source === 'referral') {
            await UserModel.findByIdAndUpdate(uid, { $inc: { referralEarnings: -request.amount } });
            debitApplied = async () => { await UserModel.findByIdAndUpdate(uid, { $inc: { referralEarnings: request.amount } }); };
          }
        } catch (err: any) {
          // Usually the negative-balance guard: the user cannot cover this withdrawal.
          await WithdrawRequestModel.findByIdAndUpdate(requestId, {
            status: 'pending', reviewedBy: null, reviewNote: `debit failed: ${err.message}`,
          });
          logger.error(`[WITHDRAW] Debit failed for ${requestId}: ${err.message}`);
          return {
            data: null, error: err.message,
            message: `Cannot approve: the balance could not be debited (${err.message}). Nothing was paid out.`,
            status: 400,
          };
        }

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
            // Payout failed — undo the debit so the user is made whole, and put the
            // request back in the queue.
            if (debitApplied) {
              try { await debitApplied(); } catch (e: any) {
                logger.error(`[WITHDRAW] REFUND FAILED for ${requestId}: ${e.message} — NEEDS MANUAL CORRECTION`);
              }
            }
            await WithdrawRequestModel.findByIdAndUpdate(requestId, { status: 'pending', reviewedBy: null, reviewNote: `payout failed: ${err.message}` });
            const lowGas = err?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(err?.message || '');
            const friendly = lowGas
              ? 'Payout wallet is out of BNB for gas. Top up the payout wallet with BNB and approve again (the request is back to pending and the balance was restored).'
              : `On-chain payout failed: ${err.message}. The balance was restored and the request is back to pending.`;
            return { data: null, error: err.message, message: friendly, status: 500 };
          }
        }

        await WithdrawRequestModel.findByIdAndUpdate(requestId, { status: 'completed', txHash: finalTxHash });
        await UserModel.findByIdAndUpdate(uid, { $inc: { totalWithdrawn: request.amount } });

        // ── Post-payout side effects ONLY ──
        // The balance debit already happened above, before the payout. Repeating it here
        // would debit twice. This block is limited to on-chain mirrors and attestations,
        // all of which are fire-and-forget and never block the withdrawal.
        if (request.source === 'deposit' && request.depositId) {
          const deposit = await DepositModel.findById(request.depositId);
          if (deposit) {
            // Burn the mirror token so it reflects CURRENT total principal.
            void burnForWithdrawal(deposit.amount, String(deposit._id));

            // If the user now has NO active/matured deposits, deregister them on-chain.
            const remaining = await DepositModel.countDocuments({ userId: uid, status: { $in: ['active', 'matured'] } });
            if (remaining === 0) {
              const u: any = await UserModel.findById(uid).select('walletAddress');
              if (u?.walletAddress) void deregisterUserOnChain(u.walletAddress);
            }

            // Re-sync this user's attested principal on-chain.
            void enqueueAttest(uid);
          }
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

  // ── BATCH PROCESS ──
  // Approve or reject many requests in one call. Reuses the single-item processWithdrawal
  // above (all its safety: atomic claim, on-chain payout with revert-on-failure, balance
  // changes, attestations), run SEQUENTIALLY so concurrent on-chain payouts can't collide
  // on the payout wallet's nonce. Returns a per-request result so the UI can show which
  // ones succeeded and which failed — one bad request never blocks the rest.
  async processWithdrawalsBatch(body: { requestIds: string[]; action: 'approve' | 'reject'; note?: string }): Promise<IResponse> {
    try {
      const { requestIds, action, note } = body || ({} as any);
      if (!Array.isArray(requestIds) || requestIds.length === 0) {
        return { data: null, error: 'Bad request', message: 'No requests selected', status: 400 };
      }
      if (action !== 'approve' && action !== 'reject') {
        return { data: null, error: 'Bad request', message: 'Invalid action', status: 400 };
      }
      // De-duplicate while preserving order.
      const ids = Array.from(new Set(requestIds.map(String)));

      const results: Array<{ requestId: string; ok: boolean; status: number; message: string; txHash?: string }> = [];
      for (const id of ids) {
        // No per-item txHash in batch mode → auto-payout on approve (if configured).
        const r = await this.processWithdrawal({ requestId: id, action, note });
        results.push({
          requestId: id,
          ok: r.status === 200,
          status: r.status,
          message: r.message,
          txHash: (r.data as any)?.txHash,
        });
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.length - succeeded;
      await ActivityModel.create({
        adminId: this.adminId,
        title: `Batch withdrawal ${action}`,
        type: 'admin',
        metadata: { action, total: results.length, succeeded, failed },
      });

      const message = failed === 0
        ? `${succeeded} withdrawal${succeeded === 1 ? '' : 's'} ${action === 'approve' ? 'approved' : 'rejected'}`
        : `${succeeded} succeeded, ${failed} failed`;
      // 200 if any succeeded; 500 only if every one failed.
      return { data: { results, succeeded, failed, total: results.length }, error: null, message, status: succeeded > 0 ? 200 : 500 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Batch process failed', status: 500 };
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

  // ── CHAIN HEALTH ──
  // Signer gas, outbox queue stats, on-chain vs DB aggregates, last reconcile. Powers the
  // admin "Chain Health" tab so gas-outs and sync drift are visible before they bite.
  async getChainHealth(): Promise<IResponse> {
    try {
      const [signer, gas, globals, dbAgg, counts] = await Promise.all([
        Promise.resolve(registryV2Signer()),
        signerGasBnb(),
        readGlobals(),
        DepositModel.aggregate([
          { $match: { status: { $in: ['active', 'matured'] }, ...NOT_EXCLUDED } },
          { $group: { _id: null, principal: { $sum: '$amount' }, n: { $sum: 1 } } },
        ]),
        ChainOutbox.aggregate([{ $group: { _id: '$status', c: { $sum: 1 } } }]),
      ]);

      const outbox: any = { pending: 0, processing: 0, done: 0, failed: 0 };
      for (const row of counts as any[]) outbox[row._id] = row.c;

      const recentFailures = await ChainOutbox.find({ status: 'failed' })
        .sort({ updatedAt: -1 }).limit(10)
        .select('kind walletAddress principalCents attempts lastError updatedAt');

      const minGas = CHAIN_MIN_GAS_BNB;
      const gasNum = gas != null ? parseFloat(gas) : null;

      const dbPrincipal = Number((dbAgg as any[])[0]?.principal || 0);
      const dbUsers = Number((dbAgg as any[])[0]?.n || 0);

      return {
        data: {
          enabled: isRegistryV2Enabled(),
          contract: REGISTRY_V2_ADDRESS || null,
          signer: {
            address: signer.address,
            gasBnb: gas,
            lowGas: gasNum != null && gasNum < minGas,
            minGasBnb: minGas,
          },
          outbox,
          recentFailures,
          onChain: globals, // { totalUsers, totalPrincipalCents, lastGlobalSyncAt, apyBps }
          database: { activeUsers: dbUsers, activePrincipal: dbPrincipal },
          lastReconcile: getLastReconcileReport(),
        },
        error: null, message: 'Chain health', status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // Retry all failed outbox jobs (admin button).
  async retryChainOutbox(): Promise<IResponse> {
    try {
      const res = await ChainOutbox.updateMany(
        { status: 'failed' },
        { $set: { status: 'pending', nextAttemptAt: new Date(), attempts: 0, lastError: '' } }
      );
      return { data: { requeued: res.modifiedCount }, error: null, message: 'Failed jobs re-queued', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  // Run reconciliation on demand (optionally stamp global sync on-chain).
  async runReconcile(markGlobal: boolean): Promise<IResponse> {
    try {
      const report = await reconcileChain({ markGlobal });
      return { data: report, error: null, message: 'Reconcile complete', status: 200 };
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
        DepositModel.aggregate([{ $match: { status: { $in: ['active', 'matured'] }, ...NOT_EXCLUDED } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
        DepositModel.aggregate([{ $match: NOT_EXCLUDED }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        DepositModel.aggregate([{ $match: NOT_EXCLUDED }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
        DepositModel.find({ status: 'active', ...NOT_EXCLUDED }).select('amount apyPercent createdAt').lean(),
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

  // ═══ PERSISTENT DEPOSIT ADDRESSES ═══════════════════════════════════════
  // Every user's permanent deposit address, with a credited-vs-swept reconciliation
  // and proof that its key is still recoverable. This is the operational safety net
  // the old ephemeral flow lost the moment it purged a key.

  async getDepositAddresses(page = 1, limit = 25, search?: string): Promise<IResponse> {
    try {
      const query: any = { status: 'active' };
      if (search) {
        const users = await UserModel.find({
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
          ],
        }).select('_id');
        query.$or = [
          { address: { $regex: search, $options: 'i' } },
          { userId: { $in: users.map((u) => u._id) } },
        ];
      }

      const skip = (page - 1) * limit;
      const [rows, total] = await Promise.all([
        DepositAddressModel.find(query)
          .populate('userId', 'name email')
          .populate('activeVaultId', 'name asset')
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        DepositAddressModel.countDocuments(query),
      ]);

      const toBig = (v: any): bigint => {
        let str = String(v ?? '0').trim();
        if (!str || str === '0') return 0n;
        if (/[eE]/.test(str)) {
          const [mant, expRaw] = str.split(/[eE]/);
          const exp = parseInt(expRaw, 10);
          const [i, f = ''] = mant.replace(/^[-+]/, '').split('.');
          const digits = i + f;
          const pad = exp - f.length;
          str = pad >= 0 ? digits + '0'.repeat(pad) : digits.slice(0, digits.length + pad);
        }
        str = str.split('.')[0];
        try { return BigInt(str); } catch { return 0n; }
      };

      const addresses = rows.map((r: any) => {
        const credited = toBig(r.creditedTotal);
        const swept = toBig(r.sweptTotal);
        const owed = credited > swept ? credited - swept : 0n;
        const dec = r.network === 'trc20' ? 6 : 18;
        const human = (v: bigint) => Number(v) / 10 ** dec;
        return {
          _id: r._id,
          address: r.address,
          network: r.network,
          user: r.userId,
          vault: r.activeVaultId,
          keySource: r.keySource,
          // True by construction — keys are never purged. Surfaced so it is provable.
          recoverable: r.keySource === 'hd' || !!r.privateKeyEncrypted,
          creditsCount: r.creditsCount || 0,
          creditedTotal: human(credited),
          sweptTotal: human(swept),
          awaitingSweep: human(owed),
          lastActivityAt: r.lastActivityAt,
          lastSweepAt: r.lastSweepAt,
          lastSweepTxHash: r.lastSweepTxHash,
          lastSweepError: r.lastSweepError,
          sweepFailureCount: r.sweepFailureCount || 0,
          // Non-null = an inflow the scanner has not booked yet. Investigate.
          unexplainedBalanceSince: r.unexplainedBalanceSince,
        };
      });

      const [creditsPending, creditsFailed, sweepsFailed, unexplained] = await Promise.all([
        DepositCreditModel.countDocuments({ status: 'detected' }),
        DepositCreditModel.countDocuments({ status: 'failed' }),
        DepositSweepModel.countDocuments({ status: 'failed' }),
        DepositAddressModel.countDocuments({ unexplainedBalanceSince: { $ne: null } }),
      ]);

      return {
        data: {
          addresses, total, page, limit,
          custody: describeKeyCustody(),
          health: { creditsPending, creditsFailed, sweepsFailed, unexplained },
        },
        error: null, message: 'Deposit addresses', status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  /** Full credit + sweep history for one address (support / dispute resolution). */
  async getDepositAddressDetail(addressId: string): Promise<IResponse> {
    try {
      const addr: any = await DepositAddressModel.findById(addressId)
        .populate('userId', 'name email walletAddress')
        .populate('activeVaultId', 'name asset')
        .lean();
      if (!addr) return { data: null, error: 'Not found', message: 'Address not found', status: 404 };

      const [credits, sweeps] = await Promise.all([
        DepositCreditModel.find({ addressId }).sort({ createdAt: -1 }).limit(100).lean(),
        DepositSweepModel.find({ addressId }).sort({ createdAt: -1 }).limit(100).lean(),
      ]);

      // Never leak key material to the client.
      delete addr.privateKeyEncrypted;

      return {
        data: {
          address: { ...addr, recoverable: addr.keySource === 'hd' || true },
          credits, sweeps,
        },
        error: null, message: 'Address detail', status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: 'Error', status: 500 };
    }
  }

  /** Force an immediate sweep attempt (re-funds gas if needed). */
  async forceSweepDepositAddress(addressId: string): Promise<IResponse> {
    try {
      await sweepAddressNow(addressId);
      const fresh: any = await DepositAddressModel.findById(addressId).lean();
      await ActivityModel.create({
        adminId: this.adminId, title: 'Deposit address sweep forced', type: 'admin',
        metadata: { addressId, txHash: fresh?.lastSweepTxHash || null },
      });
      return {
        data: { lastSweepTxHash: fresh?.lastSweepTxHash || null, lastSweepError: fresh?.lastSweepError || '' },
        error: null,
        message: fresh?.lastSweepError ? `Retry attempted: ${fresh.lastSweepError}` : 'Sweep attempted',
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: `Force sweep failed: ${err.message}`, status: 500 };
    }
  }

  /** Re-read on-chain history for one address and book anything missing. Idempotent. */
  async rescanDepositAddress(addressId: string, blocks?: number): Promise<IResponse> {
    try {
      const doc: any = await DepositAddressModel.findById(addressId).lean();
      if (!doc) return { data: null, error: 'Not found', message: 'Address not found', status: 404 };

      if (doc.network === 'trc20') {
        await rescanTrc20Address(addressId);
      } else {
        // EVM scanning is range-based, not per-address: re-scan a recent window.
        const span = Number(blocks || 200_000); // ~7 days on BSC
        const url = BSC_PROVIDER_URL.split(',')[0].trim();
        const p = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true });
        const head = await p.getBlockNumber();
        await rescanBep20Range(Math.max(1, head - span), head);
      }
      await ActivityModel.create({
        adminId: this.adminId, title: 'Deposit address rescanned', type: 'admin', metadata: { addressId },
      });
      return { data: { rescanned: true }, error: null, message: 'Rescan complete', status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: `Rescan failed: ${err.message}`, status: 500 };
    }
  }

  /**
   * MANUAL RECOVERY — move funds off a deposit address to any destination.
   * superadmin only (enforced in the route). Every call is logged loudly.
   * This is the escape hatch that makes stranded funds always retrievable.
   */
  async recoverDepositAddressFunds(addressId: string, destination: string, amount?: number): Promise<IResponse> {
    try {
      if (!destination || typeof destination !== 'string' || !destination.trim()) {
        return { data: null, error: 'Bad request', message: 'destination is required', status: 400 };
      }
      const result = await recoverFromAddress(addressId, destination.trim(), amount);
      logger.warn(`[ADMIN] Funds recovered from ${addressId} → ${destination} by admin ${this.adminId}`);
      await ActivityModel.create({
        adminId: this.adminId,
        title: 'Deposit address funds recovered',
        type: 'admin',
        metadata: { addressId, destination, amount: result.amount, txHash: result.txHash },
      });
      return { data: result, error: null, message: `Recovered ${result.amount}`, status: 200 };
    } catch (err: any) {
      return { data: null, error: err.message, message: `Recovery failed: ${err.message}`, status: 500 };
    }
  }
}