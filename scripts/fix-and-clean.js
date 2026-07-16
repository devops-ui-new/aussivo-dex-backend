/*
 * fix-and-clean.js — one-time remediation for the yield / matured-vault state.
 * =====================================================================================
 * Model (exactly as intended):
 *   • A 30-day cycle starts on each deposit's createdAt.
 *   • completedCycles = floor((now − createdAt) / 30 days).
 *   • monthlyYield    = amount × (apyPercent / 12) / 100.
 *   • maturedYield    = completedCycles × monthlyYield   → goes to the user's MATURED VAULT
 *                        (withdrawable: yieldWalletUSDT / yieldWalletUSDC).
 *   • The current, un-matured cycle is ACCRUING only (computed live on the frontend from
 *     createdAt) and becomes withdrawable when its 30 days complete.
 *
 * What it does (idempotent — safe to run more than once):
 *   1. Recomputes every deposit's cyclesMatured, maturedYield, and sets totalYieldPaid =
 *      maturedYield (so the withdrawable balance equals whole-cycle matured yield only).
 *   2. Sets each user's yieldWalletUSDT / yieldWalletUSDC = (matured for that asset across
 *      their deposits) − (yield already withdrawn via non-rejected requests).
 *   3. Deletes withdrawal-request history for users who never actually withdrew (only
 *      rejected / none) so their first real withdrawal starts clean.
 *   4. Marks the specified deposit(s) as manual for the admin origin badge.
 *
 * Usage (run from the backend project root, where .env with MONGO_URI lives):
 *   Dry run (no writes):     node scripts/fix-and-clean.js
 *   Apply:                   APPLY=true node scripts/fix-and-clean.js
 *   Rebuild yield history correctly (daily rows → one row per matured 30-day cycle):
 *                            APPLY=true REBUILD_YIELD_LOGS=true node scripts/fix-and-clean.js
 *   Clear yield history entirely instead:
 *                            APPLY=true CLEAR_ALL_YIELD_LOGS=true node scripts/fix-and-clean.js
 *   Keep withdrawal history (skip step 3):
 *                            APPLY=true CLEAR_WITHDRAWALS=false node scripts/fix-and-clean.js
 *
 * NOTE: This fixes the CURRENT state. Your ongoing accrual/maturation cron must use the SAME
 * model (monthly = annual/12; credit one whole cycle every 30 days) or the state will drift
 * again. Review the cron before re-enabling it.
 * =====================================================================================
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.env.APPLY === 'true';
const CLEAR_WITHDRAWALS = process.env.CLEAR_WITHDRAWALS !== 'false'; // default ON
const CLEAR_YIELD_LOGS = process.env.CLEAR_YIELD_LOGS === 'true';    // default OFF (only non-withdrawn users)
const CLEAR_ALL_YIELD_LOGS = process.env.CLEAR_ALL_YIELD_LOGS === 'true'; // default OFF (wipes ALL legacy daily yield-logs)
const REBUILD_YIELD_LOGS = process.env.REBUILD_YIELD_LOGS === 'true';     // default OFF (replace daily logs with one correct row per matured 30-day cycle)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aussivo-dex';

const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
const NOW = Date.now();
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Deposits to flag as manual (admin-entered / off-chain settlements).
// Matched by txHash (stable & unique) — more reliable than _id across re-imports.
const MANUAL_DEPOSIT_QUERIES = [
  { txHash: '0x96a9a2bb164094ec5d019030a0ea4b3bca8877a90e048fb198098201dfb74515' }, // $58,000 manual settlement
];

const toOid = (id) => new mongoose.Types.ObjectId(id);

(async () => {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const Deposits = db.collection('deposits');
  const Users = db.collection('users');
  const WR = db.collection('withdraw-requests');
  const YL = db.collection('yield-logs');

  console.log(`\n=== fix-and-clean  (${APPLY ? 'APPLY — WRITING' : 'DRY RUN — no writes'}) ===`);
  console.log(`    now: ${new Date(NOW).toISOString()}   cycle: 30 days\n`);

  const deposits = await Deposits.find({}).toArray();
  const wrAll = await WR.find({}).toArray();

  // 1) recompute deposits + accumulate per-user matured wallet (by asset)
  const wallet = {}; // uid -> { USDT, USDC }
  const addW = (uid, asset, v) => { (wallet[uid] = wallet[uid] || { USDT: 0, USDC: 0 })[asset] += v; };
  const depUpdates = [];
  const ylRebuild = []; // { deposit, created, monthly, cycles }
  let depChanged = 0;
  for (const d of deposits) {
    const created = new Date(d.createdAt).getTime();
    const end = (d.status === 'withdrawn' && d.withdrawnAt) ? new Date(d.withdrawnAt).getTime() : NOW;
    const monthly = d.amount * ((d.apyPercent || 0) / 12) / 100;
    const cycles = Math.max(0, Math.floor((end - created) / CYCLE_MS));
    const matured = round6(cycles * monthly);
    addW(String(d.userId), d.asset, matured);
    depUpdates.push({ _id: d._id, cyclesMatured: cycles, maturedYield: matured, totalYieldPaid: matured });
    ylRebuild.push({ deposit: d, created, monthly, cycles });
    if ((d.cyclesMatured || 0) !== cycles || round6(d.maturedYield || 0) !== matured || round6(d.totalYieldPaid || 0) !== matured) depChanged++;
  }

  // 2) yield already withdrawn (non-rejected) + who has ever really withdrawn
  const withdrawnYield = {}; // `${uid}:${asset}` -> amount
  const realWithdrawUsers = new Set();
  for (const w of wrAll) {
    if (['completed', 'approved', 'pending'].includes(w.status)) {
      realWithdrawUsers.add(String(w.userId));
      if (w.source === 'yield') {
        const k = `${String(w.userId)}:${w.asset}`;
        withdrawnYield[k] = (withdrawnYield[k] || 0) + Number(w.amount || 0);
      }
    }
  }

  // 3) user wallet updates
  const users = await Users.find({}).project({ yieldWalletUSDT: 1, yieldWalletUSDC: 1 }).toArray();
  const umap = Object.fromEntries(users.map((u) => [String(u._id), u]));
  const userUpdates = [];
  let grand = 0;
  for (const uid of Object.keys(wallet)) {
    const usdt = Math.max(0, round6(wallet[uid].USDT - (withdrawnYield[`${uid}:USDT`] || 0)));
    const usdc = Math.max(0, round6(wallet[uid].USDC - (withdrawnYield[`${uid}:USDC`] || 0)));
    const u = umap[uid] || {};
    userUpdates.push({ uid, usdt, usdc, curUsdt: Number(u.yieldWalletUSDT || 0), curUsdc: Number(u.yieldWalletUSDC || 0) });
    grand += usdt + usdc;
  }

  // 4) history to delete (users with requests but none real)
  const usersWithReq = new Set(wrAll.map((w) => String(w.userId)));
  const deleteHistoryUsers = [...usersWithReq].filter((u) => !realWithdrawUsers.has(u));
  const wrToDelete = wrAll.filter((w) => deleteHistoryUsers.includes(String(w.userId)));

  // ── REPORT ──
  console.log(`1) Deposits: ${depUpdates.length} total, ${depChanged} need recompute (cyclesMatured / maturedYield / totalYieldPaid).`);
  console.log(`\n2) Matured-vault wallets (entitled − already-withdrawn):`);
  for (const uu of userUpdates.sort((a, b) => (b.usdt + b.usdc) - (a.usdt + a.usdc))) {
    const changed = Math.abs(uu.usdt - uu.curUsdt) > 1e-6 || Math.abs(uu.usdc - uu.curUsdc) > 1e-6;
    if (changed) console.log(`   ${uu.uid.slice(0, 10)}  USDT ${uu.curUsdt.toFixed(4)}→${uu.usdt.toFixed(4)}   USDC ${uu.curUsdc.toFixed(4)}→${uu.usdc.toFixed(4)}`);
  }
  console.log(`   GRAND TOTAL withdrawable matured yield after fix: $${round6(grand)}`);
  console.log(`\n3) History cleanup: ${deleteHistoryUsers.length} users have only rejected/no withdrawals → delete ${wrToDelete.length} withdraw-request docs${CLEAR_WITHDRAWALS ? '' : '  (SKIPPED via CLEAR_WITHDRAWALS=false)'}.`);
  if (CLEAR_YIELD_LOGS) {
    const ylCount = await YL.countDocuments({ userId: { $in: deleteHistoryUsers.map(toOid) } });
    console.log(`   + yield-logs for those users to delete: ${ylCount}`);
  }
  if (CLEAR_ALL_YIELD_LOGS) {
    const ylAll = await YL.countDocuments({});
    console.log(`   + ALL legacy yield-logs to delete (clears "Recent Yield Payments"): ${ylAll}`);
  }
  if (REBUILD_YIELD_LOGS) {
    const oldVault = await YL.countDocuments({ source: 'vault_apy' });
    const newCount = ylRebuild.reduce((s, r) => s + r.cycles, 0);
    const newSum = round6(ylRebuild.reduce((s, r) => s + r.cycles * r.monthly, 0));
    console.log(`\n5) Rebuild yield-logs: replace ${oldVault} daily 'vault_apy' rows → ${newCount} per-cycle rows (Σ $${newSum}, matches matured total).`);
  }
  console.log(`\n4) Manual flag: ${MANUAL_DEPOSIT_QUERIES.length} deposit(s) → manual:true (by txHash).`);

  // ── APPLY ──
  if (!APPLY) {
    console.log(`\nDRY RUN complete — nothing written. Re-run with APPLY=true to apply.\n`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nApplying…`);
  const bulk = depUpdates.map((du) => ({ updateOne: { filter: { _id: du._id }, update: { $set: { cyclesMatured: du.cyclesMatured, maturedYield: du.maturedYield, totalYieldPaid: du.totalYieldPaid } } } }));
  if (bulk.length) { const r = await Deposits.bulkWrite(bulk); console.log(`   deposits updated: ${r.modifiedCount}`); }

  let uw = 0;
  for (const uu of userUpdates) {
    const r = await Users.updateOne({ _id: toOid(uu.uid) }, { $set: { yieldWalletUSDT: uu.usdt, yieldWalletUSDC: uu.usdc } });
    uw += r.modifiedCount;
  }
  console.log(`   user wallets set: ${uw}`);

  if (CLEAR_WITHDRAWALS && deleteHistoryUsers.length) {
    const r = await WR.deleteMany({ userId: { $in: deleteHistoryUsers.map(toOid) } });
    console.log(`   withdraw-requests deleted: ${r.deletedCount}`);
  }
  if (CLEAR_YIELD_LOGS && deleteHistoryUsers.length) {
    const r = await YL.deleteMany({ userId: { $in: deleteHistoryUsers.map(toOid) } });
    console.log(`   yield-logs deleted: ${r.deletedCount}`);
  }
  if (CLEAR_ALL_YIELD_LOGS && !REBUILD_YIELD_LOGS) {
    const r = await YL.deleteMany({});
    console.log(`   ALL legacy yield-logs deleted: ${r.deletedCount}`);
  }

  if (REBUILD_YIELD_LOGS) {
    // Replace the daily 'vault_apy' rows with one correct row per matured 30-day cycle.
    const del = await YL.deleteMany({ source: 'vault_apy' });
    const docs = [];
    for (const r of ylRebuild) {
      const d = r.deposit;
      for (let k = 1; k <= r.cycles; k++) {
        const at = new Date(r.created + k * CYCLE_MS);
        docs.push({
          userId: d.userId, depositId: d._id, vaultId: d.vaultId,
          amount: round6(r.monthly), asset: d.asset, apyPercent: d.apyPercent,
          depositAmount: d.amount, paymentNumber: k, source: 'vault_apy',
          referredUserId: null, createdAt: at, updatedAt: at,
        });
      }
    }
    if (docs.length) await YL.insertMany(docs);
    console.log(`   yield-logs rebuilt: deleted ${del.deletedCount} daily rows, inserted ${docs.length} per-cycle rows`);
  }

  const rm = await Deposits.updateMany({ $or: MANUAL_DEPOSIT_QUERIES }, { $set: { manual: true } });
  console.log(`   deposits marked manual: matched ${rm.matchedCount}, modified ${rm.modifiedCount}`);

  console.log(`\nDone. ✅  Matured yield is now correctly in each user's vault; users can request withdrawals cleanly.\n`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });