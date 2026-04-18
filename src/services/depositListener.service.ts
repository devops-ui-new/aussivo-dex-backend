import { ethers } from 'ethers';
import { BSC_PROVIDER_URL, VAULT_CONTRACT_ADDRESS } from '../configs/constants';
import DepositModel from '../models/deposit.model';
import UserModel from '../models/user.model';
import VaultModel from '../models/vault.model';
import ActivityModel from '../models/activity.model';
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
      // Watch for ERC20 transfers TO the vault address
      // This covers both USDT and USDC deposits
      const usdtAddresses = [
        '0x55d398326f99059fF775485246999027B3197955', // BSC USDT
        '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // BSC USDC
      ];

      for (const tokenAddr of usdtAddresses) {
        const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.provider);
        const decimals = await tokenContract.decimals().catch(() => 18);
        const symbol = tokenAddr.includes('55d398') ? 'USDT' : 'USDC';

        // Filter: any Transfer TO our vault address
        const filter = tokenContract.filters.Transfer(null, VAULT_CONTRACT_ADDRESS);

        tokenContract.on(filter, async (from: string, to: string, value: bigint, event: any) => {
          try {
            const amount = parseFloat(ethers.formatUnits(value, decimals));
            const txHash = event.log?.transactionHash || '';

            logger.info(`[DepositListener] ${symbol} transfer detected: ${amount} from ${from} tx:${txHash}`);

            // Check if this tx already processed
            const existing = await DepositModel.findOne({ txHash });
            if (existing) {
              logger.info(`[DepositListener] Tx ${txHash} already processed, skipping`);
              return;
            }

            // Find user by wallet address
            const user = await UserModel.findOne({ walletAddress: from.toLowerCase() });
            if (!user) {
              logger.warn(`[DepositListener] No user found for wallet ${from}, deposit will need manual confirmation`);
              // Log it for admin to review
              await ActivityModel.create({
                title: 'Unknown Deposit Detected',
                description: `${amount} ${symbol} from unknown wallet ${from}`,
                type: 'system',
                metadata: { from, amount, symbol, txHash }
              });
              return;
            }

            // Find appropriate vault (first active vault matching the asset)
            const vault = await VaultModel.findOne({ asset: symbol, status: 'active' }).sort({ createdAt: -1 });
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
