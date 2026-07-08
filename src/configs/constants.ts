import path from 'path';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load project-root .env. `override: true` so values here win over empty vars in the shell/IDE (otherwise TREASURY_* can stay blank).
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

export const PORT = process.env.PORT || '4000';
export const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aussivo-dex';
export const JWT_SECRET = process.env.JWT_SECRET || 'aussivo-dex-secret-change-in-production';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@aussivo.com';
export const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin@123';
export const ENVIRONMENT = process.env.ENVIRONMENT || 'development';
export const CRON_SECRET = process.env.CRON_SECRET || 'cron-secret-key';

// Blockchain
export const BSC_PROVIDER_URL = process.env.BSC_PROVIDER_URL || 'https://bsc-dataseed1.binance.org';
const _chain = parseInt(process.env.BSC_CHAIN_ID || '56', 10); // 56 mainnet, 97 testnet
export const BSC_CHAIN_ID = Number.isFinite(_chain) && _chain > 0 ? _chain : 56;
export const VAULT_CONTRACT_ADDRESS = process.env.VAULT_CONTRACT_ADDRESS || '';
export const ADMIN_WALLET_PRIVATE_KEY = process.env.ADMIN_WALLET_PRIVATE_KEY || '';

/** Ephemeral deposit wallets: encrypt private keys at rest (min 8 chars; use a long random string in prod). */
export const EPHEMERAL_WALLET_SECRET = process.env.EPHEMERAL_WALLET_SECRET || 'dev-only-change-me';
/** Strip quotes/BOM; checksum via ethers so validation matches what we send on-chain. */
function resolveEvmAddress(raw: string | undefined): string {
  const s = (raw ?? '')
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^["']+|["']+$/g, '');
  if (!s || !/^0x[0-9a-fA-F]{40}$/i.test(s)) return '';
  try {
    return ethers.getAddress(s);
  } catch {
    try {
      return ethers.getAddress(s.toLowerCase());
    } catch {
      return '';
    }
  }
}

/** Stablecoins swept here after detected on ephemeral address. */
export const TREASURY_WALLET_ADDRESS = resolveEvmAddress(process.env.TREASURY_WALLET_ADDRESS);
/** Optional: fund each ephemeral address with BNB so it can pay gas for the ERC-20 sweep. */
export const GAS_FUNDER_PRIVATE_KEY = (process.env.GAS_FUNDER_PRIVATE_KEY || '').trim();
export const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS || '0x55d398326f99059fF775485246999027B3197955';
export const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

// ─── TRON / TRC20 ───────────────────────────────────────────────────────────
// TRC20 USDT lives on Tron (base58 addresses, 6 decimals, energy/bandwidth gas — NOT EVM).
export const TRON_FULL_HOST = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
export const TRON_API_KEY = (process.env.TRON_API_KEY || '').trim(); // TronGrid API key (recommended)
export const TRON_USDT_CONTRACT = process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // mainnet USDT-TRC20
export const TRON_USDT_DECIMALS = 6; // TRC20 USDT uses 6 decimals (BEP20 uses 18)
export const TRON_TREASURY_ADDRESS = (process.env.TRON_TREASURY_ADDRESS || '').trim(); // where TRC20 deposits are swept
export const TRON_GAS_FUNDER_PRIVATE_KEY = (process.env.TRON_GAS_FUNDER_PRIVATE_KEY || '').trim(); // funds TRX for energy
export const TRON_GAS_TOPUP_TRX = Number(process.env.TRON_GAS_TOPUP_TRX || '35'); // TRX sent to each ephemeral to cover a USDT transfer

// Read-only reports API key — lets a partner team pull the treasury summary WITHOUT an admin JWT.
// Generate a strong value: `openssl rand -hex 32`. Leave blank to keep the reports API disabled.
export const REPORTS_API_KEY = (process.env.REPORTS_API_KEY || '').trim();

/** Canonical BSC USDT/USDC — all use 18 decimals. Avoids flaky `decimals()` eth_call on public RPC. */
const CANONICAL_BSC_STABLE_DECIMALS: Record<string, number> = {
  '0x55d398326f99059f775485246999027b3197955': 18, // mainnet USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18, // mainnet USDC
  '0x337610d27c682e347c9cd60bd4b3b107c9d34ddd': 18, // testnet USDT
  '0x64544969ed7ebbf5f083679233325356ebe738930': 18, // testnet USDC
};

/** Returns 18 for known BSC stables, else `null` (caller may fall back to 18 or read on-chain). */
export const getCanonicalBscStableDecimals = (addr: string): number | null => {
  const k = (addr || '').toLowerCase();
  return k in CANONICAL_BSC_STABLE_DECIMALS ? CANONICAL_BSC_STABLE_DECIMALS[k]! : null;
};

// Email (SMTP)
export const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';
export const EMAIL_FROM = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@aussivo.com';
export const EMAIL_FROM_NAME = process.env.SMTP_FROM_NAME || process.env.EMAIL_FROM_NAME || 'Aussivo.DEX';

// APY Config
// Crediting is per-deposit on 30-day rolling cycles (see apyDistribution.helper.ts).
// The cron only needs to run often enough to catch each deposit's 30-day mark, so it
// runs DAILY by default. (Use '0 * * * *' for hourly if you want tighter crediting.)
export const APY_CRON_SCHEDULE = process.env.APY_CRON_SCHEDULE || '0 0 * * *';
export const REFERRAL_L1_PERCENT = parseFloat(process.env.REFERRAL_L1_PERCENT || '0.35');
export const REFERRAL_L2_PERCENT = parseFloat(process.env.REFERRAL_L2_PERCENT || '0.15');

// Early-exit fee: charged (in basis points) when yield/principal/referral is withdrawn BEFORE the
// deposit's 30-day mark. 100 bps = 1%. After 30 days there is no fee. Retained by treasury.
export const EARLY_EXIT_FEE_BPS = Number(process.env.EARLY_EXIT_FEE_BPS || '100');

// ─── On-chain user registry (attestation only, no funds) ───
// Records which wallets are registered/active users so anyone can verify on-chain.
export const REGISTRY_CONTRACT_ADDRESS = (process.env.REGISTRY_CONTRACT_ADDRESS || '').trim();
export const REGISTRY_OWNER_PRIVATE_KEY = (process.env.REGISTRY_OWNER_PRIVATE_KEY || '').trim();

// On-chain deposit mirror token (18-dec ERC20). Accounting mirror only — NOT proof of reserves.
export const STAKED_TOKEN_ADDRESS = (process.env.STAKED_TOKEN_ADDRESS || '').trim();
export const STAKED_TOKEN_OWNER_PRIVATE_KEY = (process.env.STAKED_TOKEN_OWNER_PRIVATE_KEY || '').trim();
// Memo written on-chain with each mint/burn (visible on BscScan Logs). Use your own label only —
// never reference an unrelated third-party protocol, which would imply a false association.
export const STAKED_TOKEN_MEMO = (process.env.STAKED_TOKEN_MEMO || 'Aussivo deposit mirror').trim();

// Frontend
export const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dex.aussivo.com';