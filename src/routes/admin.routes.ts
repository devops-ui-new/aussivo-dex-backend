import express, { Request, Response } from 'express';
import AdminController from '../controllers/admin.controller';
import { sendResponse } from '../utils/response.util';
import { authenticateAdmin, authenticateCron } from '../middlewares/auth.middleware';
const router = express.Router();

// Auth
router.post('/login', async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).login(req.body); return sendResponse(res, r.status, r);
});

// Dashboard
router.get('/dashboard', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getDashboard(); return sendResponse(res, r.status, r);
});

// Vaults
router.get('/vaults', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getAllVaults(); return sendResponse(res, r.status, r);
});
router.post('/vaults', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).createVault(req.body); return sendResponse(res, r.status, r);
});
router.put('/vaults/:id', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).updateVault(req.params.id, req.body); return sendResponse(res, r.status, r);
});

// Users
router.get('/users', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getUsers(Number(req.query.page) || 1, Number(req.query.limit) || 20, req.query.search as string);
  return sendResponse(res, r.status, r);
});
router.get('/users/:id', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getUserById(req.params.id); return sendResponse(res, r.status, r);
});

// Deposits
router.get('/deposits', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getAllDeposits(Number(req.query.page) || 1, Number(req.query.limit) || 20, req.query.vaultId as string, req.query.status as string);
  return sendResponse(res, r.status, r);
});
// Withdrawals
router.get('/withdrawals', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getWithdrawRequests(Number(req.query.page) || 1, Number(req.query.limit) || 20, req.query.status as string);
  return sendResponse(res, r.status, r);
});
router.post('/withdrawals/process', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).processWithdrawal(req.body); return sendResponse(res, r.status, r);
});

// APY
router.post('/distribute-apy', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).triggerAPYDistribution(); return sendResponse(res, r.status, r);
});
router.get('/yield-logs', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getYieldLogs(Number(req.query.page) || 1, Number(req.query.limit) || 20, req.query.source as string);
  return sendResponse(res, r.status, r);
});

// Referrals
router.get('/referral-stats', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getReferralStats(); return sendResponse(res, r.status, r);
});

// Activity
router.get('/activity-logs', authenticateAdmin, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).getActivityLogs(Number(req.query.page) || 1, Number(req.query.limit) || 50);
  return sendResponse(res, r.status, r);
});

// Cron endpoint
router.post('/cron/distribute-apy', authenticateCron, async (req: Request, res: Response) => {
  const r = await new AdminController(req, res).triggerAPYDistribution(); return sendResponse(res, r.status, r);
});

export default router;
