import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { JWT_SECRET, CRON_SECRET, REPORTS_API_KEY, STEP_UP_WINDOW_MINUTES } from '../configs/constants';
import { sendResponse } from '../utils/response.util';

// Read-only reports key (partner teams). Timing-safe compare; disabled unless REPORTS_API_KEY is set.
export const authenticateReportKey = (req: Request | any, res: Response, next: NextFunction) => {
  if (!REPORTS_API_KEY) {
    return sendResponse(res, 503, { data: null, error: 'Disabled', message: 'Reports API is not enabled', status: 503 });
  }
  const provided = String(
    (req.headers['x-api-key'] as string) || req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.key || ''
  );
  const a = Buffer.from(provided);
  const b = Buffer.from(REPORTS_API_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return sendResponse(res, 401, { data: null, error: 'Unauthorized', message: 'Invalid API key', status: 401 });
  next();
};

export const authenticateUser = (req: Request | any, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return sendResponse(res, 401, { data: null, error: 'No token', message: 'Authentication required', status: 401 });
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.role !== 'user') return sendResponse(res, 403, { data: null, error: 'Forbidden', message: 'User access required', status: 403 });
    // FAIL CLOSED. A token without an explicit authLevel predates this check, and we
    // cannot tell how it was obtained — including whether it came from the old
    // address-only wallet login. Treating it as limited costs those users one email code
    // on their next withdrawal; treating it as verified would leave the bypass live for
    // the full 7-day token lifetime.
    req.body.user = {
      id: decoded.id,
      email: decoded.email,
      authLevel: decoded.authLevel || 'wallet',
      verifiedAt: Number(decoded.verifiedAt || 0),
    };
    next();
  } catch {
    return sendResponse(res, 401, { data: null, error: 'Invalid token', message: 'Invalid or expired token', status: 401 });
  }
};

export const authenticateAdmin = (req: Request | any, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return sendResponse(res, 401, { data: null, error: 'No token', message: 'Admin authentication required', status: 401 });
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!['superadmin', 'admin', 'operator'].includes(decoded.role)) {
      return sendResponse(res, 403, { data: null, error: 'Forbidden', message: 'Admin access required', status: 403 });
    }
    req.body.admin = { id: decoded.id, email: decoded.email, role: decoded.role };
    next();
  } catch {
    return sendResponse(res, 401, { data: null, error: 'Invalid token', message: 'Invalid or expired admin token', status: 401 });
  }
};

export const authenticateCron = (req: Request | any, res: Response, next: NextFunction) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== CRON_SECRET) return sendResponse(res, 403, { data: null, error: 'Forbidden', message: 'Invalid cron secret', status: 403 });
  next();
};

/**
 * Step-up guard for actions that move money or change where money can be sent.
 *
 * A wallet-only session proves nothing — addresses are public. It is fine for browsing,
 * but withdrawing, or linking a new payout wallet, requires a session verified by email
 * OTP. Without this split, anyone who reads a depositor address off a block explorer
 * could log in, link their own wallet, and withdraw to it.
 *
 * Returns a machine-readable code so the frontend can trigger the OTP flow it already has.
 */
export const requireVerifiedSession = (req: Request | any, res: Response, next: NextFunction) => {
  const level = req.body?.user?.authLevel;
  const verifiedAt = Number(req.body?.user?.verifiedAt || 0);

  if (level !== 'otp') {
    return sendResponse(res, 403, {
      data: { reason: 'verification_required', authLevel: level || 'wallet' },
      error: 'verification_required',
      message: 'For your security, please confirm this action with the code sent to your email.',
      status: 403,
    });
  }

  // An OTP session older than the window must re-verify. A token minted before
  // `verifiedAt` existed has 0 here, so it is treated as expired — fail closed.
  const ageSec = Math.floor(Date.now() / 1000) - verifiedAt;
  if (!verifiedAt || ageSec > STEP_UP_WINDOW_MINUTES * 60) {
    return sendResponse(res, 403, {
      data: { reason: 'verification_expired', authLevel: 'otp', windowMinutes: STEP_UP_WINDOW_MINUTES },
      error: 'verification_required',
      message: `Your verification has expired. Please confirm again with the code sent to your email.`,
      status: 403,
    });
  }

  next();
};