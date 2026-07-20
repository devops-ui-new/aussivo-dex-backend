/**
 * trace-address.js — dump EVERY record for one deposit address, next to on-chain truth.
 *
 * Answers "where did this credit come from" precisely, instead of by inference. Shows the
 * full credit ledger (labelling which detector produced each row), the sweep ledger, the
 * deposit records, the cached totals, and what the chain actually says.
 *
 * READ-ONLY. Writes nothing.
 *
 * USAGE
 *   node scripts/trace-address.js 0x1025bB0686291b1E44E680bbC8b1e9f0f84EeFe0
 *   node scripts/trace-address.js TPq2JWT2cJhGFyYVpCJw8n7vk71Ja2EUJ7
 *   node scripts/trace-address.js            # traces every active address
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ethers } = require('ethers');

let TronWeb = null;
try { ({ TronWeb } = require('tronweb')); } catch {}

const TARGET = (process.argv[2] || '').trim();
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aussivo-dex';
const BSC_RPC = (process.env.BSC_PROVIDER_URL || 'https://bsc-dataseed1.binance.org')
  .split(',').map(s => s.trim()).filter(Boolean)[0];
const USDT = process.env.USDT_CONTRACT_ADDRESS || '0x55d398326f99059fF775485246999027B3197955';
const USDC = process.env.USDC_CONTRACT_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const TRON_HOST = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
const TRON_KEY = (process.env.TRON_API_KEY || '').trim();
const TRON_USDT = process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const d128 = (v) => {
  let s = String(v ?? '0').trim();
  if (/[eE]/.test(s)) {
    const [m, e] = s.split(/[eE]/); const exp = parseInt(e, 10);
    const [i, f = ''] = m.replace(/^[-+]/, '').split('.');
    const digits = i + f; const pad = exp - f.length;
    s = pad >= 0 ? digits + '0'.repeat(pad) : digits.slice(0, digits.length + pad);
  }
  try { return BigInt(s.split('.')[0]); } catch { return 0n; }
};
const ts = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '—');

(async () => {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const q = TARGET
    ? { $or: [{ address: TARGET }, { addressLookup: TARGET.toLowerCase() }, { addressLookup: TARGET }] }
    : { status: 'active' };
  const addrs = await db.collection('deposit_addresses').find(q).toArray();

  if (!addrs.length) { console.log('No matching deposit address.'); await mongoose.disconnect(); return; }

  for (const a of addrs) {
    const dec = a.network === 'trc20' ? 6 : 18;
    const h = (v) => (Number(v) / 10 ** dec).toFixed(6);
    const user = await db.collection('users').findOne({ _id: a.userId }, { projection: { email: 1, usdtBalance: 1, usdcBalance: 1 } });

    console.log('\n' + '='.repeat(100));
    console.log(`${a.network.toUpperCase()}  ${a.address}`);
    console.log(`user: ${(user && user.email) || a.userId}`);
    console.log('='.repeat(100));

    // ── On-chain truth ──
    let onChain = null;
    try {
      if (a.network === 'trc20') {
        if (TronWeb) {
          const o = { fullHost: TRON_HOST };
          if (TRON_KEY) o.headers = { 'TRON-PRO-API-KEY': TRON_KEY };
          const tw = new TronWeb(o);
          tw.setAddress(a.address);
          const c = await tw.contract().at(TRON_USDT);
          onChain = BigInt((await c.balanceOf(a.address).call()).toString());
        }
      } else {
        const p = new ethers.JsonRpcProvider(BSC_RPC, undefined, { staticNetwork: true });
        const t = new ethers.Contract(USDT, ['function balanceOf(address) view returns (uint256)'], p);
        onChain = await t.balanceOf(a.address);
      }
    } catch (e) { console.log(`  (on-chain read failed: ${e.message})`); }

    // ── Credit ledger ──
    const credits = await db.collection('deposit_credits')
      .find({ addressId: a._id }).sort({ createdAt: 1 }).toArray();
    console.log('\nCREDITS (what we told the user they deposited)');
    if (!credits.length) console.log('  none');
    let creditedSum = 0n;
    for (const c of credits) {
      const src = String(c.txHash).startsWith('balance:') ? 'BALANCE-FALLBACK' : 'chain-scanner   ';
      const counted = c.status === 'credited';
      if (counted) { try { creditedSum += BigInt(c.amountBaseUnits); } catch {} }
      console.log(
        `  ${ts(c.createdAt)}  ${String(c.amount).padStart(10)}  ${src}  ${c.status.padEnd(9)}` +
        `  ${String(c.txHash).slice(0, 50)}`
      );
      if (c.depositId) console.log(`      -> deposit ${c.depositId}`);
    }

    // ── Sweep ledger ──
    const sweeps = await db.collection('deposit_sweeps')
      .find({ addressId: a._id }).sort({ createdAt: 1 }).toArray();
    console.log('\nSWEEPS (what we moved to treasury)');
    if (!sweeps.length) console.log('  none');
    let sweptSum = 0n;
    for (const s of sweeps) {
      if (s.status === 'confirmed') { try { sweptSum += BigInt(s.amountBaseUnits); } catch {} }
      console.log(`  ${ts(s.createdAt)}  ${String(s.amount).padStart(10)}  ${s.status.padEnd(10)}  ${String(s.txHash).slice(0, 66)}`);
      if (s.error) console.log(`      error: ${s.error}`);
    }

    // ── Deposits actually booked ──
    const deps = await db.collection('deposits')
      .find({ pendingRequestId: { $regex: `^xfer:${a.network}:` } }).sort({ createdAt: 1 }).toArray();
    const mine = deps.filter(d => String(d.userId) === String(a.userId));
    console.log('\nDEPOSIT RECORDS (what appears in the user portfolio)');
    if (!mine.length) console.log('  none');
    let depSum = 0;
    for (const d of mine) {
      depSum += Number(d.amount || 0);
      console.log(`  ${ts(d.createdAt)}  ${String(d.amount).padStart(10)} ${d.asset}  ${d.status.padEnd(10)}  ${String(d.pendingRequestId).slice(0, 60)}`);
    }

    // ── Verdict ──
    console.log('\nRECONCILIATION');
    console.log(`  cached creditedTotal : ${h(d128(a.creditedTotal))}`);
    console.log(`  ledger credit sum    : ${h(creditedSum)}${d128(a.creditedTotal) !== creditedSum ? '   <-- CACHE DRIFT' : ''}`);
    console.log(`  cached sweptTotal    : ${h(d128(a.sweptTotal))}`);
    console.log(`  ledger sweep sum     : ${h(sweptSum)}${d128(a.sweptTotal) !== sweptSum ? '   <-- CACHE DRIFT' : ''}`);
    console.log(`  deposit records sum  : ${depSum.toFixed(6)}`);
    if (onChain !== null) {
      const maxLegit = onChain + sweptSum;
      console.log(`  on-chain balance now : ${h(onChain)}`);
      console.log(`  max legitimate credit: ${h(maxLegit)}   (on-chain + swept)`);
      if (creditedSum > maxLegit) {
        console.log(`\n  *** OVER-CREDITED BY ${h(creditedSum - maxLegit)} ***`);
        console.log('  The user was credited more than ever reached this address.');
        const fb = credits.filter(c => String(c.txHash).startsWith('balance:') && c.status === 'credited');
        const sc = credits.filter(c => !String(c.txHash).startsWith('balance:') && c.status === 'credited');
        console.log(`  ${fb.length} balance-fallback credit(s), ${sc.length} chain-scanner credit(s).`);
        if (fb.length && sc.length) {
          console.log('  Both detectors credited — this is the duplicate-detector bug.');
        } else if (fb.length > 1) {
          console.log('  Multiple fallback credits — the fallback fired more than once for the same funds.');
        }
      } else if (creditedSum < maxLegit) {
        console.log(`\n  UNDER-CREDITED by ${h(maxLegit - creditedSum)} — funds arrived that the user has not been credited for.`);
      } else {
        console.log('\n  Balanced. Every credited dollar is backed by on-chain funds.');
      }
    }
  }

  console.log('\n' + '='.repeat(100));
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});