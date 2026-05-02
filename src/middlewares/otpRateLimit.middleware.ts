import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { sendResponse } from '../utils/response.util';

const otpSendByIpLimiter = new RateLimiterMemory({
  keyPrefix: 'otp_send_ip',
  points: 8,
  duration: 60 * 15, // 8 requests / 15 min / IP
  blockDuration: 60 * 15,
});

const otpSendByEmailLimiter = new RateLimiterMemory({
  keyPrefix: 'otp_send_email',
  points: 5,
  duration: 60 * 15, // 5 requests / 15 min / email
  blockDuration: 60 * 15,
});

const otpVerifyByIpLimiter = new RateLimiterMemory({
  keyPrefix: 'otp_verify_ip',
  points: 25,
  duration: 60 * 15, // 25 verify requests / 15 min / IP
  blockDuration: 60 * 15,
});

const normalizeIp = (req: Request): string => {
  const fwd = (req.headers['x-forwarded-for'] as string) || '';
  return (fwd.split(',')[0] || req.ip || '').trim() || 'unknown-ip';
};

const normalizeEmail = (raw: unknown): string => String(raw || '').trim().toLowerCase();

export const otpSendRateLimit = async (req: Request, res: Response, next: NextFunction) => {
  const ip = normalizeIp(req);
  const email = normalizeEmail((req.body || {}).email);

  try {
    await otpSendByIpLimiter.consume(ip);
    if (email) await otpSendByEmailLimiter.consume(email);
    return next();
  } catch (rlRes: any) {
    const waitSec = Math.max(1, Math.ceil((rlRes?.msBeforeNext || 60000) / 1000));
    return sendResponse(res, 429, {
      data: null,
      error: 'Rate limit exceeded',
      message: `Too many OTP requests. Try again in ${waitSec}s`,
      status: 429,
    });
  }
};

export const otpVerifyRateLimit = async (req: Request, res: Response, next: NextFunction) => {
  const ip = normalizeIp(req);
  try {
    await otpVerifyByIpLimiter.consume(ip);
    return next();
  } catch (rlRes: any) {
    const waitSec = Math.max(1, Math.ceil((rlRes?.msBeforeNext || 60000) / 1000));
    return sendResponse(res, 429, {
      data: null,
      error: 'Rate limit exceeded',
      message: `Too many verification attempts. Try again in ${waitSec}s`,
      status: 429,
    });
  }
};

