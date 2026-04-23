import { ethers } from 'ethers';
import {
  ADMIN_WALLET_PRIVATE_KEY,
  BSC_PROVIDER_URL,
  USDC_CONTRACT_ADDRESS,
  USDT_CONTRACT_ADDRESS,
  VAULT_CONTRACT_ADDRESS,
} from '../configs/constants';
import logger from '../configs/logger.config';

const VAULT_ABI = [
  'function payoutUser(address token, address user, uint256 amount, string reason) external',
  'function getBalance(address token) external view returns (uint256)',
  'function owner() external view returns (address)',
];
const ERC20_ABI = ['function decimals() view returns (uint8)'];

const decimalsCache: Record<string, number> = {};

export const isVaultPayoutConfigured = (): boolean =>
  Boolean(VAULT_CONTRACT_ADDRESS && ADMIN_WALLET_PRIVATE_KEY);

const getProvider = () => new ethers.JsonRpcProvider(BSC_PROVIDER_URL);

const getDecimals = async (tokenAddr: string, provider: ethers.JsonRpcProvider): Promise<number> => {
  if (decimalsCache[tokenAddr] != null) return decimalsCache[tokenAddr];
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  const d = Number(await token.decimals());
  decimalsCache[tokenAddr] = d;
  return d;
};

export interface PayoutResult {
  txHash: string;
  blockNumber: number;
}

/**
 * Calls AussivoVault.payoutUser() as the contract owner to transfer stablecoin
 * from the vault to a user wallet. Signer: ADMIN_WALLET_PRIVATE_KEY.
 */
export const payoutUserOnChain = async (params: {
  asset: 'USDT' | 'USDC';
  userAddress: string;
  amount: number;
  reason?: string;
}): Promise<PayoutResult> => {
  if (!isVaultPayoutConfigured())
    throw new Error('Vault payout not configured (missing VAULT_CONTRACT_ADDRESS or ADMIN_WALLET_PRIVATE_KEY)');
  if (!ethers.isAddress(params.userAddress))
    throw new Error(`Invalid user wallet address: ${params.userAddress}`);
  if (!(params.amount > 0))
    throw new Error('Amount must be > 0');

  const tokenAddr = params.asset === 'USDT' ? USDT_CONTRACT_ADDRESS : USDC_CONTRACT_ADDRESS;
  const provider = getProvider();
  const wallet = new ethers.Wallet(ADMIN_WALLET_PRIVATE_KEY, provider);
  const vault = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, wallet);

  const decimals = await getDecimals(tokenAddr, provider);
  const amountWei = ethers.parseUnits(String(params.amount), decimals);

  logger.info(
    `[VaultPayout] sending ${params.amount} ${params.asset} → ${params.userAddress} (signer=${wallet.address})`
  );

  const tx = await vault.payoutUser(tokenAddr, params.userAddress, amountWei, params.reason || '');
  logger.info(`[VaultPayout] tx broadcast: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1)
    throw new Error(`Payout tx reverted (hash=${tx.hash})`);
  logger.info(`[VaultPayout] confirmed block=${receipt.blockNumber} tx=${tx.hash}`);

  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
};
