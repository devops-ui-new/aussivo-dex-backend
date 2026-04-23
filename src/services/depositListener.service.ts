import { ethers } from 'ethers';
import { BSC_PROVIDER_URL, VAULT_CONTRACT_ADDRESS, USDT_CONTRACT_ADDRESS, USDC_CONTRACT_ADDRESS } from '../configs/constants';
import DepositModel from '../models/deposit.model';
import UserModel from '../models/user.model';
import VaultModel from '../models/vault.model';
import ActivityModel from '../models/activity.model';
import PendingDepositModel from '../models/pendingDeposit.model';
import { sendEmail } from '../configs/email.config';
import logger from '../configs/logger.config';

// Minimal ABI for deposit events
const VAULT_ABI = [
  "event Deposited(uint256 indexed poolId, address indexed user, uint256 amount, uint256 depositIndex, uint256 lockUntil)",
  "event Withdrawn(uint256 indexed poolId, address indexed user, uint256 amount, uint256 rewards, uint256 penalty)",
];

// USDT/USDC ERC20 Transfer event
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

export class DepositListenerService {
  private provider: ethers.JsonRpcProvider;
  private isRunning = false;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(BSC_PROVIDER_URL);
  }

  /**
   * Start listening for USDT/USDC transfers TO vault contract address
   * This auto-confirms deposits when users send stablecoins to the vault
   */
  async start() {
    if (!VAULT_CONTRACT_ADDRESS) {
      logger.warn('[DepositListener] No VAULT_CONTRACT_ADDRESS configured, skipping listener');
      return;
    }

    if (this.isRunning) {
      logger.warn('[DepositListener] Already running');
      return;
    }

    this.isRunning = true;
    logger.info(`[DepositListener] Starting... Watching ${VAULT_CONTRACT_ADDRESS}`);

    try {
      // Watch for ERC20 transfers TO the vault address (both USDT & USDC)
      const tokens = [
        { addr: USDT_CONTRACT_ADDRESS, symbol: 'USDT' },
        { addr: USDC_CONTRACT_ADDRESS, symbol: 'USDC' },
      ];

      for (const { addr: tokenAddr, symbol } of tokens) {
        const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.provider);
        const decimals = await tokenContract.decimals().catch(() => 18);

        // Filter: any Transfer TO our vault address
        const filter = tokenContract.filters.Transfer(null, VAULT_CONTRACT_ADDRESS);

        tokenContract.on(filter, async (...listenerArgs: any[]) => {
          try {
            // ethers v6 quirk: with typed filters, decoded positional args can arrive
            // as null. Parse the raw log instead, which is always reliable.
            const event = listenerArgs[listenerArgs.length - 1];
            const log = event?.log || event;
            if (!log?.topics || !log?.data) {
              logger.warn(`[DepositListener] ${symbol} event missing log payload`);
              return;
            }
            const parsed = tokenContract.interface.parseLog({
              topics: [...log.topics],
              data: log.data,
            });
            if (!parsed) {
              logger.warn(`[DepositListener] ${symbol} log could not be parsed`);
              return;
            }
            const from: string = parsed.args.from;
            const value: bigint = parsed.args.value;
            const txHash: string = log.transactionHash || '';

            if (value == null) {
              logger.warn(`[DepositListener] ${symbol} parsed value was null — skipping tx ${txHash}`);
              return;
            }

            const amount = parseFloat(ethers.formatUnits(value, decimals));

            logger.info(`[DepositListener] ${symbol} transfer detected: ${amount} from ${from} tx:${txHash}`);

            // Check if this tx already processed
            const existing = await DepositModel.findOne({ txHash });
            if (existing) {
              logger.info(`[DepositListener] Tx ${txHash} already processed, skipping`);
              return;
            }

            // Per-vault routing. Order of matching:
            //   1. Pending intent with matching wallet + asset + amount (best — user's linked wallet paid)
            //   2. Pending intent with matching asset + amount, only if UNIQUE (QR scan from a
            //      different wallet than the one linked to the user's account)
            //   3. User lookup by wallet (legacy path, no pending intent)
            const AMOUNT_TOLERANCE = 0.01;
            const now = new Date();

            let pending = await PendingDepositModel.findOne({
              walletAddress: from.toLowerCase(),
              asset: symbol,
              status: 'pending',
              expiresAt: { $gt: now },
              expectedAmount: { $gte: amount - AMOUNT_TOLERANCE, $lte: amount + AMOUNT_TOLERANCE },
            }).sort({ createdAt: -1 });

            if (!pending) {
              const candidates = await PendingDepositModel.find({
                asset: symbol,
                status: 'pending',
                expiresAt: { $gt: now },
                expectedAmount: { $gte: amount - AMOUNT_TOLERANCE, $lte: amount + AMOUNT_TOLERANCE },
              }).sort({ createdAt: 1 });
              if (candidates.length === 1) {
                pending = candidates[0];
                logger.info(`[DepositListener] Cross-wallet match: intent ${pending._id} for user ${pending.userId} claims tx from ${from}`);
              } else if (candidates.length > 1) {
                logger.warn(`[DepositListener] ${candidates.length} active intents match ${amount} ${symbol} from ${from} — refusing to auto-route`);
              }
            }

            let user: any = null;
            if (pending) {
              user = await UserModel.findById(pending.userId);
            }
            if (!user) {
              const fromLower = from.toLowerCase();
              user = await UserModel.findOne({
                $or: [{ walletAddress: fromLower }, { walletAddresses: fromLower }],
              });
            }
            if (!user) {
              logger.warn(`[DepositListener] No user or pending intent for ${amount} ${symbol} from ${from}`);
              await ActivityModel.create({
                title: 'Unknown Deposit Detected',
                description: `${amount} ${symbol} from unknown wallet ${from}`,
                type: 'system',
                metadata: { from, amount, symbol, txHash },
              });
              return;
            }

            // Auto-link the paying wallet to this user's walletAddresses so future deposits
            // from it route directly. Skip if another user already claims this wallet.
            const fromLower = from.toLowerCase();
            const known = (user.walletAddresses || []).map((w: string) => (w || '').toLowerCase());
            if (!known.includes(fromLower)) {
              const conflict = await UserModel.findOne({
                _id: { $ne: user._id },
                $or: [{ walletAddress: fromLower }, { walletAddresses: fromLower }],
              });
              if (!conflict) {
                user.walletAddresses = [...known, fromLower];
                if (!user.walletAddress || !user.walletAddress.startsWith('0x')) user.walletAddress = fromLower;
                await user.save();
                logger.info(`[DepositListener] Auto-linked wallet ${fromLower} to user ${user.email}`);
              }
            }

            let vault;
            if (pending) {
              vault = await VaultModel.findById(pending.vaultId);
              if (vault) {
                await PendingDepositModel.findByIdAndUpdate(pending._id, {
                  status: 'matched',
                  matchedTxHash: txHash,
                  matchedAt: now,
                });
                logger.info(`[DepositListener] Matched intent ${pending._id} → vault ${vault.name}`);
              }
            }
            if (!vault) {
              vault = await VaultModel.findOne({ asset: symbol, status: 'active' }).sort({ createdAt: -1 });
              if (vault) logger.warn(`[DepositListener] No pending intent for ${from} ${amount} ${symbol}, falling back to newest active vault ${vault.name}`);
            }
            if (!vault) {
              logger.warn(`[DepositListener] No active ${symbol} vault found`);
              return;
            }

            // Determine tier
            let tierIndex = 0;
            let apyPercent = vault.tiers[0]?.apyPercent || 0;
            for (let i = vault.tiers.length - 1; i >= 0; i--) {
              if (amount >= vault.tiers[i].minAmount) {
                tierIndex = i;
                apyPercent = vault.tiers[i].apyPercent;
                break;
              }
            }

            const lockUntil = vault.lockDays > 0
              ? new Date(Date.now() + vault.lockDays * 86400000)
              : null;

            // Create deposit record
            const deposit = await DepositModel.create({
              userId: user._id,
              vaultId: vault._id,
              amount,
              asset: symbol,
              txHash,
              walletAddress: from.toLowerCase(),
              lockUntil,
              apyPercent,
              tierIndex,
              maxYieldPayments: vault.durationMonths,
              status: 'active',
            });

            // Update vault TVL
            await VaultModel.findByIdAndUpdate(vault._id, {
              $inc: { totalStaked: amount, totalUsers: 1 }
            });

            // Update user balance
            const balField = symbol === 'USDT' ? 'usdtBalance' : 'usdcBalance';
            await UserModel.findByIdAndUpdate(user._id, {
              $inc: { [balField]: amount, totalDeposited: amount }
            });

            // Activity log
            await ActivityModel.create({
              userId: user._id,
              title: 'Auto-Confirmed Deposit',
              description: `$${amount} ${symbol} deposit auto-confirmed from on-chain tx`,
              type: 'deposit',
              metadata: { vaultId: vault._id, depositId: deposit._id, amount, txHash }
            });

            // Send deposit confirmation email
            const monthlyYield = (amount * apyPercent / 100).toFixed(2);
            await sendEmail(user.email, '✅ Deposit Confirmed — Aussivo.DEX', 'deposit-confirmation', {
              name: user.name,
              amount: amount.toFixed(2),
              asset: symbol,
              vaultName: vault.name,
              apyPercent: apyPercent.toFixed(1),
              monthlyYield,
              lockDays: vault.lockDays,
              txHash,
              txHashShort: txHash ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : 'N/A',
              date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            });

            logger.info(`[DepositListener] ✅ Auto-confirmed deposit: ${amount} ${symbol} for ${user.email} in ${vault.name}`);
          } catch (err: any) {
            logger.error(`[DepositListener] Error processing transfer: ${err.message}`);
          }
        });

        logger.info(`[DepositListener] Watching ${symbol} transfers to vault`);
      }
    } catch (err: any) {
      logger.error(`[DepositListener] Failed to start: ${err.message}`);
      this.isRunning = false;
    }
  }

  stop() {
    this.isRunning = false;
    this.provider.removeAllListeners();
    logger.info('[DepositListener] Stopped');
  }
}

export const depositListener = new DepositListenerService();
