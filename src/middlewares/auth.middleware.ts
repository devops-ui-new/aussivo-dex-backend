import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { JWT_SECRET, CRON_SECRET, REPORTS_API_KEY } from '../configs/constants';
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
    req.body.user = { id: decoded.id, email: decoded.email };
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