import dotenv from 'dotenv';
dotenv.config();

export const PORT = process.env.PORT || '4000';
export const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aussivo-dex';
export const JWT_SECRET = process.env.JWT_SECRET || 'aussivo-dex-secret-change-in-production';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@aussivo.com';
export const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin@123';
export const ENVIRONMENT = process.env.ENVIRONMENT || 'development';
export const CRON_SECRET = process.env.CRON_SECRET || 'cron-secret-key';

// Blockchain
export const BSC_PROVIDER_URL = process.env.BSC_PROVIDER_URL || 'https://bsc-dataseed1.binance.org';
export const VAULT_CONTRACT_ADDRESS = process.env.VAULT_CONTRACT_ADDRESS || '';
export const ADMIN_WALLET_PRIVATE_KEY = process.env.ADMIN_WALLET_PRIVATE_KEY || '';

// Email (SMTP)
export const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';
export const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@aussivo.com';

// APY Config
export const APY_CRON_SCHEDULE = process.env.APY_CRON_SCHEDULE || '0 0 1 * *';
export const REFERRAL_L1_PERCENT = parseFloat(process.env.REFERRAL_L1_PERCENT || '0.35');
export const REFERRAL_L2_PERCENT = parseFloat(process.env.REFERRAL_L2_PERCENT || '0.15');

// Frontend
export const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dex.aussivo.com';
