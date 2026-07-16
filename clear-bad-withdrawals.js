/**
 * clear-bad-withdrawals.js — surgically REJECT pending withdrawal requests that are stale/invalid,
 * so fix-yield-data.js can then recompute clean balances. RUN THIS FIRST, before the fix.
 *
 * Why first: fix-yield-data.js treats a 'pending' request as already-committed and subtracts it
 * from the corrected wallet. Leaving inflated pending requests in place would corrupt the fix.
 * Rejecting them first removes that commitment so the fix computes purely from true entitlement.
 *
 * WHAT IT REJECTS (yield/referral requests only):
 *   - any pending 'yield' or 'referral' request whose amount EXCEEDS the user's current wallet
 *     balance for that asset (the 12x-over-credit / phantom artifacts), OR
 *   - (optional) pending 'yield' requests with absurd precision (>6 decimals) — legacy
 *     fractional-cycle artifacts. Enable with REJECT_DUST=true.
 *
 * WHAT IT LEAVES ALONE:
 *   - 'deposit' (principal) redemptions — the fix doesn't touch principal; these are handled
 *     separately. Reject them by hand in the UI only if you actually want the user to re-request.
 *
 * SAFE BY DEFAULT: dry-run unless APPLY=true.
 *
 * USAGE:
 *   mongosh "<MONGO_URI>" --file clear-bad-withdrawals.js                        # dry run
 *   mongosh "<MONGO_URI>" --eval "APPLY=true" --file clear-bad-withdrawals.js    # commit
 *   mongosh "<MONGO_URI>" --eval "APPLY=true; REJECT_DUST=true" --file clear-bad-withdrawals.js
 */

const APPLY = (typeof APPLY !== 'undefined') ? APPLY : false;
const REJECT_DUST = (typeof REJECT_DUST !== 'undefined') ? REJECT_DUST : false;
const r6 = (n) => Math.round(Number(n || 0) * 1e6) / 1e6;

print('='.repeat(92));
print(APPLY ? '*** APPLYING (rejecting) ***' : 'DRY RUN — no writes. Re-run with --eval "APPLY=true" to commit.');
print(`Reject dust (>6-decimal yield artifacts): ${REJECT_DUST}`);
print('='.repeat(92));

const pending = db['withdraw-requests'].find({ status: 'pending' }).toArray();
print(`\n${pending.length} pending request(s) total.\n`);

let rejectExceeds = 0, rejectDust = 0, keptDeposit = 0, keptOk = 0;
const toReject = [];

for (const w of pending) {
  const u = db.users.findOne({ _id: w.userId }, { email: 1, yieldWalletUSDT: 1, yieldWalletUSDC: 1, referralEarnings: 1 });
  const email = (u && u.email) || String(w.userId);
  const amt = Number(w.amount || 0);
  const src = w.source;

  if (src === 'deposit') { keptDeposit++; continue; } // principal — handled separately

  // balance this request draws from
  let bal = 0;
  if (src === 'yield') bal = Number((w.asset === 'USDC' ? u.yieldWalletUSDC : u.yieldWalletUSDT) || 0);
  else if (src === 'referral') bal = Number(u.referralEarnings || 0);

  const exceeds = amt > bal + 1e-6;
  const decimals = (String(amt).split('.')[1] || '').length;
  const dust = REJECT_DUST && src === 'yield' && decimals > 6 && amt <= bal;

  let reason = null;
  if (exceeds) { reason = `exceeds wallet ($${amt.toFixed(6)} > $${bal.toFixed(6)})`; rejectExceeds++; }
  else if (dust) { reason = `dust artifact ($${amt} , ${decimals} dp)`; rejectDust++; }
  else { keptOk++; continue; }

  toReject.push({ id: w._id, email, src, amt, bal, reason });
}

print('WILL REJECT:');
toReject.forEach(x =>
  print(`  ${(x.email).slice(0, 30).padEnd(31)} ${x.src.padEnd(8)} $${x.amt.toFixed(6).padStart(14)}  — ${x.reason}`));
print(`\nSummary: reject ${toReject.length} (exceeds=${rejectExceeds}, dust=${rejectDust}) · ` +
      `kept ${keptOk} valid yield/referral · left ${keptDeposit} deposit redemption(s) untouched.`);

if (APPLY && toReject.length) {
  const ids = toReject.map(x => x.id);
  const res = db['withdraw-requests'].updateMany(
    { _id: { $in: ids }, status: 'pending' },
    { $set: { status: 'rejected', reviewNote: 'auto-rejected: stale/invalid balance before yield-data fix' } }
  );
  print(`\nREJECTED ${res.modifiedCount} request(s).`);
} else if (!APPLY) {
  print('\nDRY RUN complete — nothing written. Re-run with --eval "APPLY=true" to reject.');
}
print('\nNext: back up (mongodump), then run fix-yield-data.js (dry-run, then APPLY=true).');