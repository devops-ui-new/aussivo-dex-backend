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
export const TRON_GAS_TOPUP_TRX = Number(process.env.TRON_GAS_TOPUP_TRX || '20'); // TRX sent to each ephemeral to cover a USDT transfer (sweep to treasury needs ~14)
// Stop re-funding a deposit that never sweeps after this many attempts (prevents draining the funder).
export const TRON_MAX_FUND_ATTEMPTS = Number(process.env.TRON_MAX_FUND_ATTEMPTS || '3');
// After a successful sweep, send the ephemeral's leftover TRX back to the funder (recovers stranded TRX).
export const TRON_RECLAIM_LEFTOVER = (process.env.TRON_RECLAIM_LEFTOVER || 'true') === 'true';

// Read-only reports API key — lets a partner team pull the treasury summary WITHOUT an admin JWT.
// Generate a strong value: `openssl rand -hex 32`. Leave blank to keep the reports API disabled.
export const REPORTS_API_KEY = (process.env.REPORTS_API_KEY || '').trim();

/** Canonical BSC USDT/USDC — all use 18 decimals. Avoids flaky `decimals()` eth_call on public RPC. */
const CANONICAL_BSC_STABLE_DECIMALS: Record<string, number> = {
  '0x55d398326f99059ff775485246999027b3197955': 18, // mainnet USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18, // mainnet USDC
  '0x337610d27c682e347c9cd60bd4b3b107c9d34ddd': 18, // testnet USDT
  '0x64544969ed7ebf5f083679233325356ebe738930': 18, // testnet USDC
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

// v2 attestation registry (per-address principal). Falls back to the v1 owner key if a dedicated
// v2 key isn't set, since it's usually the same owner wallet.
export const REGISTRY_V2_ADDRESS = (process.env.REGISTRY_V2_ADDRESS || '').trim();
export const REGISTRY_V2_OWNER_PRIVATE_KEY = (process.env.REGISTRY_V2_OWNER_PRIVATE_KEY || process.env.REGISTRY_OWNER_PRIVATE_KEY || '').trim();
// Minimum signer gas (BNB) before Chain Health flags a low-balance warning.
export const CHAIN_MIN_GAS_BNB = parseFloat(process.env.CHAIN_MIN_GAS_BNB || '0.02');

// On-chain deposit mirror token (18-dec ERC20). Accounting mirror only — NOT proof of reserves.
export const STAKED_TOKEN_ADDRESS = (process.env.STAKED_TOKEN_ADDRESS || '').trim();
export const STAKED_TOKEN_OWNER_PRIVATE_KEY = (process.env.STAKED_TOKEN_OWNER_PRIVATE_KEY || '').trim();
// Memo written on-chain with each mint/burn (visible on BscScan Logs). Use your own label only —
// never reference an unrelated third-party protocol, which would imply a false association.
export const STAKED_TOKEN_MEMO = (process.env.STAKED_TOKEN_MEMO || 'Aussivo deposit mirror').trim();

// Frontend
export const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dex.aussivo.com';
// ─── Illustrative live allocation model ──────────────────────────────────────
// Drives the "Illustrative Target Allocation" panel and the pool-card weights with a
// deterministic, wall-clock-based model (see helpers/allocationModel.ts). It is a TARGET
// MODEL only — never presented as live on-chain positions. Enable it for demos.
export const ALLOC_LIVE_MODEL = (process.env.ALLOC_LIVE_MODEL || 'false') === 'true';
// How often constituents rotate. Default 24h (realistic). For an on-stage demo set a
// short value like 20000 (20s) so an audience actually sees venues rotate.
export const ALLOC_REBALANCE_MS = Number(process.env.ALLOC_REBALANCE_MS || String(24 * 60 * 60 * 1000));
// Weight precision (still always sums to exactly 100).
export const ALLOC_DECIMALS = Number(process.env.ALLOC_DECIMALS || '1');

// ─── Persistent per-user deposit addresses ──────────────────────────────────
/** Master switch. false = existing ephemeral behaviour, completely unchanged. */
export const PERSISTENT_DEPOSIT_ADDRESSES =
  (process.env.PERSISTENT_DEPOSIT_ADDRESSES || 'false') === 'true';

/**
 * BIP-39 mnemonic that deterministically derives every deposit key.
 * When set, the database stores ONLY a derivation index — no key material at rest.
 * BACK THIS UP OFFLINE. Losing it means losing access to every deposit address.
 * Leave blank to fall back to random keys encrypted with DEPOSIT_WALLET_SECRET.
 */
export const DEPOSIT_HD_MNEMONIC = (process.env.DEPOSIT_HD_MNEMONIC || '').trim();
export const DEPOSIT_HD_PASSPHRASE = process.env.DEPOSIT_HD_PASSPHRASE || '';

/** Secret for AES-256-GCM key encryption. Falls back to the existing var so every
 *  legacy `pending_deposits.privateKeyEncrypted` row keeps decrypting unchanged. */
export const DEPOSIT_WALLET_SECRET =
  (process.env.DEPOSIT_WALLET_SECRET || process.env.EPHEMERAL_WALLET_SECRET || 'dev-only-change-me').trim();

/** Also store an encrypted copy alongside the HD index. Belt and braces during
 *  migration; set false once the mnemonic backup has been verified. */
export const DEPOSIT_KEY_BACKUP = (process.env.DEPOSIT_KEY_BACKUP || 'true') === 'true';

// Scanner tuning
export const DEPOSIT_SCAN_INTERVAL_MS = Number(process.env.DEPOSIT_SCAN_INTERVAL_MS || '15000');
export const DEPOSIT_SCAN_CONFIRMATIONS = Number(process.env.DEPOSIT_SCAN_CONFIRMATIONS || '12');
export const DEPOSIT_SCAN_MAX_SPAN = Number(process.env.DEPOSIT_SCAN_MAX_SPAN || '5000');
export const DEPOSIT_SCAN_CHUNK_BLOCKS = Number(process.env.DEPOSIT_SCAN_CHUNK_BLOCKS || '1000');
export const DEPOSIT_SCAN_ADDRESS_CHUNK = Number(process.env.DEPOSIT_SCAN_ADDRESS_CHUNK || '200');
/** Re-read this far back on every Tron poll so a boundary transfer is never skipped. */
export const TRON_SCAN_OVERLAP_MS = Number(process.env.TRON_SCAN_OVERLAP_MS || '600000');

// Sweep tuning
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || '60000');
/** Don't spend gas moving dust; it accumulates and sweeps on a later pass. */
export const SWEEP_MIN_AMOUNT_USD = Number(process.env.SWEEP_MIN_AMOUNT_USD || '1');

/**
 * BSC_PROVIDER_URL may be a COMMA-SEPARATED failover list. Anything that constructs a
 * single JsonRpcProvider must use this, never the raw value — passing the whole list
 * produces `getaddrinfo ENOTFOUND host,https`.
 */
export const BSC_PRIMARY_RPC =
  BSC_PROVIDER_URL.split(',').map((u) => u.trim()).filter(Boolean)[0] || BSC_PROVIDER_URL;

/**
 * Credit deposits from balanceOf when eth_getLogs is unavailable.
 * Most free BSC endpoints serve eth_call fine but refuse getLogs, so without this a
 * deposit can sit undetected purely because of an RPC limitation. Amount stays exact;
 * only sender attribution is lost. Default ON — correctness of the user's balance
 * matters more than the completeness of the audit trail.
 */
export const DEPOSIT_BALANCE_FALLBACK = (process.env.DEPOSIT_BALANCE_FALLBACK || 'true') === 'true';
/** Give the log scanner this long to book it properly first. */
export const DEPOSIT_BALANCE_FALLBACK_DELAY_MS = Number(process.env.DEPOSIT_BALANCE_FALLBACK_DELAY_MS || '120000');