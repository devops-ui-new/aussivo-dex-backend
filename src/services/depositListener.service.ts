import { ethers } from 'ethers';
import {
  BSC_CHAIN_ID,
  BSC_PROVIDER_URL,
  getCanonicalBscStableDecimals,
  VAULT_CONTRACT_ADDRESS,
  USDT_CONTRACT_ADDRESS,
  USDC_CONTRACT_ADDRESS,
} from '../configs/constants';
import DepositModel from '../models/deposit.model';
import UserModel from '../models/user.model';
import VaultModel from '../models/vault.model';
import ActivityModel from '../models/activity.model';
import PendingDepositModel from '../models/pendingDeposit.model';
import { sendEmail } from '../configs/email.config';
import logger from '../configs/logger.config';

// Minimal ABI for vault deposit events
const VAULT_ABI = [
  "event Deposited(address indexed user, address indexed token, uint256 amount, string vaultId, bytes32 indexed requestId)",
];

export class DepositListenerService {
  private provider: ethers.JsonRpcProvider;
  private isRunning = false;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(BSC_PROVIDER_URL, BSC_CHAIN_ID, { staticNetwork: true });
    this.provider.on('error', (err) => {
      logger.error(`[DepositListener] RPC provider error: ${(err as Error)?.message || err}`);
    });
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
    if (!ethers.isAddress(VAULT_CONTRACT_ADDRESS)) {
      logger.warn('[DepositListener] Invalid VAULT_CONTRACT_ADDRESS configured, skipping listener');
      return;
    }

    if (this.isRunning) {
      logger.warn('[DepositListener] Already running');
      return;
    }

    this.isRunning = true;
    logger.info(`[DepositListener] Starting... Watching ${VAULT_CONTRACT_ADDRESS}`);

    try {
      const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, this.provider);
      const depositFilter = vaultContract.filters.Deposited();

      vaultContract.on(depositFilter, async (...listenerArgs: any[]) => {
          try {
            const event = listenerArgs[listenerArgs.length - 1];
            const log = event?.log || event;
            if (!log?.topics || !log?.data) {
              logger.warn("[DepositListener] Deposited event missing log payload");
              return;
            }
            const parsed = vaultContract.interface.parseLog({
              topics: [...log.topics],
              data: log.data,
            });
            if (!parsed) {
              logger.warn("[DepositListener] Deposited log could not be parsed");
              return;
            }
            const txHash: string = log.transactionHash || '';
            const depositor = String(parsed.args.user || "").toLowerCase();
            const tokenAddress = String(parsed.args.token || "").toLowerCase();
            const value: bigint = parsed.args.amount;
            const requestIdRaw: string = String(parsed.args.requestId || "");
            const requestId = requestIdRaw.toLowerCase();

            if (!value || !requestId || requestId === ethers.ZeroHash) {
              logger.info(`[DepositListener] Legacy/non-request deposit event tx:${txHash}; requestId=${requestIdRaw || "n/a"} skipped for deterministic routing`);
              return;
            }

            // Check if this tx already processed
            const existing = await DepositModel.findOne({ txHash });
            if (existing) {
              logger.info(`[DepositListener] Tx ${txHash} already processed, skipping`);
              return;
            }

            const now = new Date();
            const pending = await PendingDepositModel.findOne({
              requestId: requestId.toLowerCase(),
              status: 'pending',
              expiresAt: { $gt: now },
            });
            if (!pending) {
              logger.warn(`[DepositListener] No pending intent found for requestId ${requestId} (tx ${txHash})`);
              await ActivityModel.create({
                title: 'Unknown Deposit Detected',
                description: `Deposit with unknown requestId ${requestId}`,
                type: 'system',
                metadata: { requestId, txHash },
              });
              return;
            }

            let user: any = await UserModel.findById(pending.userId);
            if (!user) {
              logger.warn(`[DepositListener] Pending intent ${pending._id} has no user ${pending.userId}`);
              return;
            }

            const symbol = tokenAddress === USDT_CONTRACT_ADDRESS.toLowerCase()
              ? 'USDT'
              : tokenAddress === USDC_CONTRACT_ADDRESS.toLowerCase()
              ? 'USDC'
              : '';
            if (!symbol) {
              logger.warn(`[DepositListener] Unsupported token ${tokenAddress} in deposit tx ${txHash}`);
              return;
            }
            if (pending.asset !== symbol) {
              logger.warn(`[DepositListener] Asset mismatch for requestId ${requestId}: pending=${pending.asset}, onchain=${symbol}`);
              return;
            }

            const decimals = getCanonicalBscStableDecimals(tokenAddress) ?? 18;
            const amount = parseFloat(ethers.formatUnits(value, decimals));
            const amountBaseUnits = value.toString();
            if (pending.expectedAmountBaseUnits !== amountBaseUnits) {
              logger.warn(`[DepositListener] Amount mismatch for requestId ${requestId}: pending=${pending.expectedAmountBaseUnits}, onchain(received)=${amountBaseUnits}. Crediting received amount.`);
            }

            // Auto-link the paying wallet to this user's walletAddresses so future deposits
            // from it route directly. Skip if another user already claims this wallet.
            const fromLower = depositor;
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

            const vault = await VaultModel.findById(pending.vaultId);
            if (!vault) {
              logger.warn(`[DepositListener] Vault not found for pending intent ${pending._id}`);
              return;
            }
            await PendingDepositModel.findByIdAndUpdate(pending._id, {
              status: 'matched',
              matchedTxHash: txHash,
              matchedAt: now,
            });
            logger.info(`[DepositListener] Matched requestId ${requestId} (intent ${pending._id}) → vault ${vault.name}`);

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
              walletAddress: depositor,
              depositorAddresses: [depositor],
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

            logger.info(`[DepositListener] ✅ Auto-confirmed requestId ${requestId}: ${amount} ${symbol} for ${user.email} in ${vault.name}`);
          } catch (err: any) {
            logger.error(`[DepositListener] Error processing transfer: ${err.message}`);
          }
        });

      logger.info('[DepositListener] Watching AussivoVault Deposited events');
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
