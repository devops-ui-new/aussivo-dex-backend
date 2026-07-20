/**
 * audit-legacy-addresses.js — READ-ONLY. Finds money stranded on old ephemeral
 * deposit addresses.
 *
 * WHY THIS EXISTS
 * Under the ephemeral design an address was dropped from every scan once it expired.
 * If a user's exchange withdrawal took longer than the window — routine — their funds
 * landed on an address nobody was watching. They were never credited and never swept.
 * This script checks the on-chain balance of every legacy address and tells you exactly
 * where that money is.
 *
 * IT WRITES NOTHING. No database updates, no transactions, no key decryption.
 * It only reads balances. Safe to run against production at any time.
 *
 * USAGE
 *   node scripts/audit-legacy-addresses.js
 *   STATUS=expired node scripts/audit-legacy-addresses.js     # only expired ones
 *   LIMIT=50 node scripts/audit-legacy-addresses.js           # cap how many to check
 *
 * ENV: MONGO_URI, BSC_PROVIDER_URL, USDT_CONTRACT_ADDRESS, USDC_CONTRACT_ADDRESS,
 *      TRON_FULL_HOST, TRON_API_KEY, TRON_USDT_CONTRACT
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ethers } = require('ethers');

let TronWeb = null;
try { ({ TronWeb } = require('tronweb')); } catch { /* optional */ }

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aussivo-dex';
const STATUS = process.env.STATUS || '';           // '' = all legacy rows
const LIMIT = Number(process.env.LIMIT || '0');    // 0 = no cap
const DELAY_MS = Number(process.env.DELAY_MS || '120');

const BSC_RPC = (process.env.BSC_PROVIDER_URL || 'https://bsc-dataseed1.binance.org')
  .split(',').map((s) => s.trim()).filter(Boolean)[0];
const USDT = process.env.USDT_CONTRACT_ADDRESS || '0x55d398326f99059fF775485246999027B3197955';
const USDC = process.env.USDC_CONTRACT_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const TRON_HOST = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
const TRON_KEY = (process.env.TRON_API_KEY || '').trim();
const TRON_USDT = process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const ERC20 = ['function balanceOf(address) view returns (uint256)'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (c = '=') => console.log(c.repeat(100));

(async () => {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  line();
  console.log('LEGACY ADDRESS BALANCE AUDIT — read-only, nothing is written');
  console.log(`BSC RPC : ${BSC_RPC}`);
  console.log(`USDT    : ${USDT}`);
  line();

  const q = { depositAddressId: { $in: [null, undefined] }, ephemeralAddress: { $nin: ['', null] } };
  if (STATUS) q.status = STATUS;

  let cur = db.collection('pending_deposits').find(q, {
    projection: {
      ephemeralAddress: 1, network: 1, asset: 1, status: 1, userId: 1,
      privateKeyEncrypted: 1, createdAt: 1, expiresAt: 1,
      receivedAmount: 1, sweepTxHash: 1, userCreditedAt: 1,
    },
  }).sort({ createdAt: -1 });
  if (LIMIT) cur = cur.limit(LIMIT);
  const rows = await cur.toArray();

  console.log(`\nChecking ${rows.length} legacy address(es)...\n`);

  const provider = new ethers.JsonRpcProvider(BSC_RPC, undefined, { staticNetwork: true });
  const usdt = new ethers.Contract(USDT, ERC20, provider);
  const usdc = new ethers.Contract(USDC, ERC20, provider);

  let tron = null;
  if (TronWeb) {
    const opts = { fullHost: TRON_HOST };
    if (TRON_KEY) opts.headers = { 'TRON-PRO-API-KEY': TRON_KEY };
    tron = new TronWeb(opts);
  }

  const found = [];
  let checked = 0, errors = 0;

  for (const r of rows) {
    const addr = r.ephemeralAddress;
    try {
      let balances = [];

      if (r.network === 'trc20') {
        if (!tron) { console.log(`  ? ${addr} (tron skipped — tronweb not installed)`); continue; }
        tron.setAddress(addr);
        const c = await tron.contract().at(TRON_USDT);
        const raw = await c.balanceOf(addr).call();
        const amt = Number(raw.toString()) / 1e6;
        if (amt > 0) balances.push({ asset: 'USDT', amount: amt });
      } else {
        const [bt, bc] = await Promise.all([usdt.balanceOf(addr), usdc.balanceOf(addr)]);
        const at = Number(ethers.formatUnits(bt, 18));
        const ac = Number(ethers.formatUnits(bc, 18));
        if (at > 0) balances.push({ asset: 'USDT', amount: at });
        if (ac > 0) balances.push({ asset: 'USDC', amount: ac });
      }

      checked++;
      if (balances.length) {
        const user = await db.collection('users').findOne({ _id: r.userId }, { projection: { email: 1, name: 1 } });
        for (const b of balances) {
          found.push({
            address: addr,
            network: r.network || 'bep20',
            status: r.status,
            asset: b.asset,
            amount: b.amount,
            hasKey: !!r.privateKeyEncrypted,
            credited: !!r.userCreditedAt,
            swept: !!r.sweepTxHash,
            email: (user && user.email) || String(r.userId),
            createdAt: r.createdAt,
          });
          console.log(
            `  ** ${String(b.amount).padStart(14)} ${b.asset}  ${addr}  ` +
            `[${r.status}]  key=${r.privateKeyEncrypted ? 'YES' : 'PURGED'}  ` +
            `credited=${r.userCreditedAt ? 'yes' : 'NO'}  ${(user && user.email) || ''}`
          );
        }
      }
      if (checked % 25 === 0) console.log(`  …${checked}/${rows.length} checked`);
    } catch (e) {
      errors++;
      console.log(`  ! error on ${addr}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  line();
  console.log(`Checked ${checked} address(es), ${errors} error(s).`);

  if (!found.length) {
    console.log('\n✅ No stranded funds found. Every legacy address is empty.');
    console.log('   Safe to retire the legacy path once pending/credited reach 0.');
  } else {
    const total = found.reduce((s, f) => s + f.amount, 0);
    const uncredited = found.filter((f) => !f.credited);
    const uncreditedTotal = uncredited.reduce((s, f) => s + f.amount, 0);
    const noKey = found.filter((f) => !f.hasKey);

    console.log(`\n⚠  STRANDED FUNDS FOUND\n`);
    console.log(`   Addresses holding a balance : ${found.length}`);
    console.log(`   Total on-chain              : $${total.toFixed(6)}`);
    console.log(`   NEVER CREDITED to a user    : ${uncredited.length} address(es), $${uncreditedTotal.toFixed(6)}`);
    console.log(`   Recoverable (key present)   : ${found.length - noKey.length} / ${found.length}`);
    if (noKey.length) {
      console.log(`\n   ✗ ${noKey.length} address(es) hold funds but the key was PURGED:`);
      noKey.forEach((f) => console.log(`       ${f.amount} ${f.asset}  ${f.address}  ${f.email}`));
    }

    console.log('\n   WHAT TO DO:');
    console.log('     1. The "never credited" ones are user money missing from their portfolio.');
    console.log('        Credit those users manually, then sweep the address.');
    console.log('     2. Sweep via the admin panel (Sweep Health → force) or by decrypting the');
    console.log('        stored key with EPHEMERAL_WALLET_SECRET.');
    console.log('     3. Do NOT delete privateKeyEncrypted from any row in this list.');

    require('fs').writeFileSync(
      'stranded-funds-report.json',
      JSON.stringify({ generatedAt: new Date().toISOString(), total, found }, null, 2)
    );
    console.log('\n   Full report written to stranded-funds-report.json');
  }
  line();

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});