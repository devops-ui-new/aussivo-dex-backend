import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cron from 'node-cron';
import mongoose from 'mongoose';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import { connectDB } from './configs/db.config';
import { bootstrapDB } from './utils/bootstrap.util';
import { PORT, APY_CRON_SCHEDULE, ENVIRONMENT } from './configs/constants';
import { distributeMonthlyAPY } from './helpers/apyDistribution.helper';
import { depositListener } from './services/depositListener.service';
import { startEphemeralDepositSweep } from './services/ephemeralDepositSweep.service';
import Routes from './routes';
import logger from './configs/logger.config';
import { sendResponse } from './utils/response.util';

connectDB(async (mongooseConn) => {
  logger.info('Connected to MongoDB');
  await bootstrapDB(() => logger.info('Database bootstrapped'));

  const app = express();

  // ── Middleware ──
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'x-cron-secret']
  }));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('combined', { stream: { write: (msg: string) => logger.info(msg.trim()) } }));

  // ── Rate Limiter ──
  const rateLimiter = new RateLimiterMongo({
    storeClient: mongooseConn.connection,
    tableName: 'apiRateLimits',
    points: 100,
    duration: 60,
    blockDuration: 60,
  });
  app.use(async (req, res, next) => {
    try {
      await rateLimiter.consume(`${req.ip}-${req.path}`);
      next();
    } catch {
      sendResponse(res, 429, { error: 'Too many requests', message: 'Rate limit exceeded. Try again in 60 seconds.', data: null, status: 429 });
    }
  });

  // ── Routes ──
  app.get('/', (_, res) => res.json({ service: 'Aussivo.DEX API', status: 'running', env: ENVIRONMENT, timestamp: new Date() }));
  app.use('/api', Routes);

  // ── APY Cron Job ──
  cron.schedule(APY_CRON_SCHEDULE, async () => {
    logger.info('[CRON] Running monthly APY distribution...');
    try {
      const result = await distributeMonthlyAPY();
      logger.info(`[CRON] Distribution complete:`, result);
    } catch (err: any) {
      logger.error('[CRON] Distribution failed:', err.message);
    }
  });
  logger.info(`[CRON] APY distribution scheduled: ${APY_CRON_SCHEDULE}`);

  // ── On-chain vault listener (optional when VAULT_CONTRACT_ADDRESS set) ──
  if (ENVIRONMENT !== 'test') {
    depositListener.start().catch(err => {
      logger.error('[DepositListener] Startup error:', err.message);
    });
    startEphemeralDepositSweep();
  }

  // ── Start Server ──
  app.listen(PORT, () => {
    logger.info(`\n╔══════════════════════════════════════════╗`);
    logger.info(`║  Aussivo.DEX Backend v1.0                ║`);
    logger.info(`║  Port: ${PORT}                              ║`);
    logger.info(`║  API:  http://localhost:${PORT}/api           ║`);
    logger.info(`║  Env:  ${ENVIRONMENT}                      ║`);
    logger.info(`╚══════════════════════════════════════════╝\n`);
  });
});
