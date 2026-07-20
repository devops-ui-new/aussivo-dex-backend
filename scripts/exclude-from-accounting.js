/**
 * exclude-from-accounting.js — mark a deposit as settled outside the platform.
 *
 * WHAT IT DOES
 *   1. Flags the deposit and its pending_deposits row with `excludedFromAccounting`.
 *   2. Decrements the vault's cached `totalStaked` / `totalUsers` by that deposit, so
 *      public TVL and the pool cards reconcile with the filtered aggregations.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - Delete anything. The rows stay for audit, just excluded from totals.
 *   - Touch the user's balance. Their portfolio is unaffected by design; the company is
 *     settling with them directly.
 *
 * SAFE BY DEFAULT — dry run unless APPLY=true.
 *
 * USAGE
 *   node scripts/exclude-from-accounting.js TUBwPQxEpccQj9xVwaWLFMv4w4LkPvUA1q
 *   APPLY=true node scripts/exclude-from-accounting.js TUBwPQxEpccQj9xVwaWLFMv4w4LkPvUA1q "Paid to user directly"
 *
 *   # reverse it
 *   APPLY=true UNDO=true node scripts/exclude-from-accounting.js TUBwPQxEpccQj9xVwaWLFMv4w4LkPvUA1q
 */
require('dotenv').config();
const mongoose = require('mongoose');

const TARGET = (process.argv[2] || '').trim();
const REASON = (process.argv[3] || 'Settled outside the platform').trim();
const APPLY = process.env.APPLY === 'true';
const UNDO = process.env.UNDO === 'true';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aussivo-dex';

if (!TARGET) {
  console.error('Usage: node scripts/exclude-from-accounting.js <address> ["reason"]');
  process.exit(1);
}

(async () => {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('='.repeat(90));
  console.log(UNDO ? 'MODE: UNDO (restoring to accounting)' : 'MODE: EXCLUDE');
  console.log(APPLY ? '*** APPLYING ***' : 'DRY RUN — no writes. Re-run with APPLY=true.');
  console.log(`Address: ${TARGET}`);
  console.log('='.repeat(90));

  const lower = TARGET.toLowerCase();

  // Match on either casing: deposits store the address lowercased, Tron is case-sensitive.
  const pending = await db.collection('pending_deposits').find({
    $or: [{ ephemeralAddress: TARGET }, { ephemeralAddress: lower }],
  }).toArray();

  const requestIds = pending.map((p) => p.requestId).filter(Boolean);
  const deposits = await db.collection('deposits').find({
    $or: [
      { walletAddress: TARGET },
      { walletAddress: lower },
      { depositorAddresses: { $in: [TARGET, lower] } },
      ...(requestIds.length ? [{ pendingRequestId: { $in: requestIds } }] : []),
    ],
  }).toArray();

  if (!deposits.length && !pending.length) {
    console.log('\nNothing matched that address. Check it and try again.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${pending.length} pending_deposits row(s), ${deposits.length} deposit(s):\n`);

  const vaultDelta = {}; // vaultId -> { amount, count }
  for (const d of deposits) {
    const user = await db.collection('users').findOne({ _id: d.userId }, { projection: { email: 1 } });
    const already = d.excludedFromAccounting === true;
    console.log(
      `  ${String(d._id)}  $${Number(d.amount).toFixed(2)} ${d.asset}  ${d.status.padEnd(9)} ` +
      `${(user && user.email) || d.userId}  ${already ? '[already excluded]' : ''}`
    );
    // Only shift the vault counter when the flag actually changes, and only for deposits
    // that are still counted as staked.
    const willChange = UNDO ? already : !already;
    if (willChange && (d.status === 'active' || d.status === 'matured')) {
      const k = String(d.vaultId);
      vaultDelta[k] = vaultDelta[k] || { amount: 0, count: 0 };
      vaultDelta[k].amount += Number(d.amount || 0);
      vaultDelta[k].count += 1;
    }
  }

  const sign = UNDO ? 1 : -1;
  console.log('\nVault counter adjustments:');
  if (!Object.keys(vaultDelta).length) console.log('  none');
  for (const [vid, v] of Object.entries(vaultDelta)) {
    const vault = await db.collection('vaults').findOne({ _id: new mongoose.Types.ObjectId(vid) }, { projection: { name: 1, totalStaked: 1, totalUsers: 1 } });
    console.log(
      `  ${vault?.name || vid}: totalStaked ${Number(vault?.totalStaked || 0).toFixed(2)} ` +
      `-> ${(Number(vault?.totalStaked || 0) + sign * v.amount).toFixed(2)}, ` +
      `totalUsers ${vault?.totalUsers || 0} -> ${(vault?.totalUsers || 0) + sign * v.count}`
    );
  }

  console.log('\nUser balances: UNCHANGED (their portfolio is settled separately).');

  if (!APPLY) {
    console.log('\nDRY RUN complete — nothing written. Re-run with APPLY=true.');
    await mongoose.disconnect();
    return;
  }

  const set = UNDO
    ? { $set: { excludedFromAccounting: false }, $unset: { excludedReason: '', excludedAt: '' } }
    : { $set: { excludedFromAccounting: true, excludedReason: REASON, excludedAt: new Date() } };

  const dIds = deposits.map((d) => d._id);
  const pIds = pending.map((p) => p._id);
  if (dIds.length) await db.collection('deposits').updateMany({ _id: { $in: dIds } }, set);
  if (pIds.length) await db.collection('pending_deposits').updateMany({ _id: { $in: pIds } }, set);

  for (const [vid, v] of Object.entries(vaultDelta)) {
    await db.collection('vaults').updateOne(
      { _id: new mongoose.Types.ObjectId(vid) },
      { $inc: { totalStaked: sign * v.amount, totalUsers: sign * v.count } }
    );
  }

  console.log(`\nDone. ${dIds.length} deposit(s) and ${pIds.length} pending row(s) updated.`);
  console.log('Restart the API (or wait for the next request) and the totals will reconcile.');
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});