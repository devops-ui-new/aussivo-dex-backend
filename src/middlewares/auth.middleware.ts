import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, CRON_SECRET } from '../configs/constants';
import { sendResponse } from '../utils/response.util';

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
