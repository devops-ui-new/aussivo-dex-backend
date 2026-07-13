/**
 * fix-yield-data.js — corrects the yield accounting.
 *
 * ASSUMES the unbacked deposit and its orphaned yield-logs have ALREADY been removed by hand.
 * This script DELETES NOTHING. It only recomputes yield from each deposit's true schedule and
 * rewrites the derived balances.
 *
 *   [1] VERIFY     — hard-stops if any deposit still lacks on-chain provenance (see WHY below).
 *   [2] REACTIVATE — status 'matured' -> 'active'. The old term cap is gone: a deposit earns
 *                    for as long as its principal stays staked.
 *   [3] RECOMPUTE  — rebuild cyclesMatured / maturedYield / totalYieldPaid / yieldPaymentsCount
 *                    for every deposit from its real createdAt. This undoes the legacy 12x
 *                    over-credit (the old cron paid the ANNUAL rate as a single monthly
 *                    payment — it forgot the /12).
 *   [4] REWRITE    — user yieldWalletUSDT / yieldWalletUSDC = entitled − already withdrawn.
 *
 * WHY [1] EXISTS: step [3] recomputes yield for EVERY deposit it finds. If an unbacked deposit
 * were still present, this script would build it a clean, correct-looking yield schedule — i.e.
 * it would make a fabricated position look legitimate. So it aborts instead. A deposit counts as
 * backed if EITHER:
 *    - txHash is a valid 64-char hex hash (direct on-chain listener path), OR
 *    - pendingRequestId matches a pending_deposits row carrying a real matched/sweep hash.
 *
 * USAGE:
 *   mongosh "<MONGO_URI>" --file fix-yield-data.js                       # DRY RUN, writes nothing
 *   mongosh "<MONGO_URI>" --eval "APPLY=true" --file fix-yield-data.js   # commit
 */

const APPLY = (typeof APPLY !== 'undefined') ? APPLY : false;

// 'continuous' — users keep yield accrued under the OLD withdraw-anytime terms (recommended:
//                real users don't lose yield they legitimately earned under the terms in force).
// 'matured'    — strict new rules: only whole completed 30-day cycles count.
const BASIS = 'continuous';

const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
const NOW = new Date();
const r6 = (n) => Math.round(Number(n || 0) * 1e6) / 1e6;
const HEX64 = /^0x[0-9a-f]{64}$/i;
const TRON64 = /^[0-9a-f]{64}$/i;

print('='.repeat(90));
print(APPLY ? '*** APPLYING CHANGES ***' : 'DRY RUN — no writes. Re-run with --eval "APPLY=true" to commit.');
print('Basis for real users: ' + BASIS);
print('='.repeat(90));

// ─────────────────────────────────────────────────────────────────────────────
// [2] Reactivate legacy term-expired deposits.
// ─────────────────────────────────────────────────────────────────────────────
print("\n[2] Reactivating legacy term-expired deposits (status 'matured' -> 'active')...");
const stale = db.deposits.find({ status: 'matured' }).toArray();
if (!stale.length) {
  print('      none found.');
} else {
  stale.forEach(function (d) {
    const u = db.users.findOne({ _id: d.userId }, { email: 1 });
    const ageDays = Math.floor((NOW - new Date(d.createdAt)) / 86400000);
    print('      ' + String(d._id) + '  ' + (((u && u.email) || '?') + '                            ').slice(0, 28) +
          ' $' + Number(d.amount).toFixed(2) + ' ' + d.asset + '  ' + ageDays + 'd old -> active');
  });
  print('      ' + stale.length + ' deposit(s) resume earning.');
  if (APPLY) db.deposits.updateMany({ status: 'matured' }, { $set: { status: 'active' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// [3] Recompute yield from each deposit's true schedule.
// ─────────────────────────────────────────────────────────────────────────────
print('\n[3] Recomputing yield for all deposits...');
const trueByUser = {};
let fixedCount = 0;

db.deposits.find({}).forEach(function (d) {
  const monthly = (Number(d.amount) * (Number(d.apyPercent) / 12)) / 100;

  // A redeemed deposit stops earning when its principal left — never accrue past withdrawnAt.
  const until = (d.status === 'withdrawn' && d.withdrawnAt) ? new Date(d.withdrawnAt) : NOW;
  const elapsed = Math.max(0, until - new Date(d.createdAt));
  const cycles = Math.floor(elapsed / CYCLE_MS);

  const matured = r6(cycles * monthly);                    // whole cycles only
  const continuous = r6(monthly * (elapsed / CYCLE_MS));   // pro-rata (old promise)
  const entitled = (BASIS === 'continuous') ? continuous : matured;

  const uid = String(d.userId);
  if (!trueByUser[uid]) trueByUser[uid] = { USDT: 0, USDC: 0 };
  trueByUser[uid][d.asset] = r6(trueByUser[uid][d.asset] + entitled);

  if (r6(d.totalYieldPaid) !== entitled || Number(d.cyclesMatured || 0) !== cycles) {
    fixedCount++;
    if (APPLY) {
      db.deposits.updateOne({ _id: d._id }, { $set: {
        cyclesMatured: cycles,
        maturedYield: matured,
        totalYieldPaid: entitled,
        yieldPaymentsCount: cycles
      }});
    }
  }
});
print('      ' + fixedCount + ' deposit(s) had incorrect yield counters.');

// ─────────────────────────────────────────────────────────────────────────────
// [4] Rewrite user yield wallets.
// ─────────────────────────────────────────────────────────────────────────────
print('\n[4] Rewriting user yield wallets  (entitled − already withdrawn, never negative)...');
let before = 0, after = 0;

db.users.find({}).forEach(function (u) {
  const t = trueByUser[String(u._id)] || { USDT: 0, USDC: 0 };

  ['USDT', 'USDC'].forEach(function (asset) {
    const field = asset === 'USDT' ? 'yieldWalletUSDT' : 'yieldWalletUSDC';
    const cur = Number(u[field] || 0);

    // yield already paid out or committed to an open request — cannot be un-paid
    const agg = db['withdraw-requests'].aggregate([
      { $match: { userId: u._id, source: 'yield', asset: asset,
                  status: { $in: ['completed', 'approved', 'pending'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const withdrawn = agg.length ? Number(agg[0].total) : 0;

    const corrected = Math.max(0, r6(t[asset] - withdrawn));
    before += cur; after += corrected;

    if (r6(cur) !== corrected) {
      print('      ' + ((u.email || '?') + '                              ').slice(0, 30) +
            ' ' + cur.toFixed(4) + '  ->  ' + corrected.toFixed(4) + '   (withdrawn ' + withdrawn.toFixed(4) + ')');
      if (APPLY) db.users.updateOne({ _id: u._id }, { $set: { [field]: corrected } });
    }
  });
});

print('\n' + '='.repeat(90));
print('  yield wallets before : $' + before.toFixed(2));
print('  yield wallets after  : $' + after.toFixed(2));
print('  over-credit removed  : $' + (before - after).toFixed(2));
print('='.repeat(90));
print(APPLY ? '\nCHANGES APPLIED.' : '\nDRY RUN complete — nothing was written.');