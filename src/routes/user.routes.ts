import express, { Request, Response } from 'express';
import UserController from '../controllers/user.controller';
import { sendResponse } from '../utils/response.util';
import { authenticateUser } from '../middlewares/auth.middleware';
const router = express.Router();

// ── Auth ──
router.post('/send-otp', async (req: Request, res: Response) => {
  const r = await new UserController(req, res).sendOTP(req.body); return sendResponse(res, r.status, r);
});
router.post('/verify-otp', async (req: Request, res: Response) => {
  const r = await new UserController(req, res).verifyOTP(req.body); return sendResponse(res, r.status, r);
});
router.post('/wallet-login', async (req: Request, res: Response) => {
  const r = await new UserController(req, res).walletLogin(req.body); return sendResponse(res, r.status, r);
});
router.post('/wallet-auth', async (req: Request, res: Response) => {
  const r = await new UserController(req, res).walletAuth(req.body); return sendResponse(res, r.status, r);
});

// ── User ──
router.get('/me', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).getUserDetails(); return sendResponse(res, r.status, r);
});
router.post('/link-wallet', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).linkWallet(req.body); return sendResponse(res, r.status, r);
});

// ── Vaults ──
router.get('/vaults', async (req: Request, res: Response) => {
  const r = await new UserController(req, res).getVaults(); return sendResponse(res, r.status, r);
});
router.get('/vault/:id', async (req: Request, res: Response) => {
  const r = await new UserController(req, res).getVaultById(req.params.id); return sendResponse(res, r.status, r);
});

// ── Deposits ──
router.post('/deposit/qr', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).getDepositQR(req.body); return sendResponse(res, r.status, r);
});
router.post('/deposit/confirm', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).recordDeposit(req.body); return sendResponse(res, r.status, r);
});
router.get('/deposits', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).getDeposits(Number(req.query.page) || 1, Number(req.query.limit) || 10); return sendResponse(res, r.status, r);
});

// ── Yield / Referral / Withdraw ──
router.get('/yield-logs', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).getYieldLogs(Number(req.query.page) || 1, Number(req.query.limit) || 20, req.query.source as string); return sendResponse(res, r.status, r);
});
router.get('/referrals', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).getReferralData(); return sendResponse(res, r.status, r);
});
router.post('/withdraw', authenticateUser, async (req: Request, res: Response) => {
  const r = await new UserController(req, res).requestWithdraw(req.body); return sendResponse(res, r.status, r);
});

export default router;
