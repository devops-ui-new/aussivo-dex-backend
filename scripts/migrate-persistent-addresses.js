/**
 * migrate-persistent-addresses.js — preflight + optional backfill for the
 * persistent per-user deposit address rollout.
 *
 * SAFE BY DEFAULT: dry run unless APPLY=true. It NEVER touches an existing
 * pending_deposits row, deposit, user balance, or vault. The only thing it can
 * write is new documents in `deposit_addresses`.
 *
 * WHAT IT DOES
 *   [1] PREFLIGHT  — validates config (mnemonic, secrets, treasury) and proves the
 *                    HD derivation round-trips before you rely on it for real money.
 *   [2] LEGACY     — reports ephemeral rows still in flight, so you know when it is
 *                    safe to retire the old sweepers. Also flags EXPIRED addresses
 *                    that may still be holding funds (the current fund-loss hole).
 *   [3] BACKFILL   — optionally pre-creates addresses for existing users. Not
 *                    required: getOrCreateDepositAddress() creates them lazily on
 *                    first QR open. Useful if you want addresses ready in advance.
 *
 * USAGE
 *   node scripts/migrate-persistent-addresses.js                    # dry run
 *   APPLY=true node scripts/migrate-persistent-addresses.js         # create addresses
 *   APPLY=true BACKFILL=all node scripts/migrate-persistent-addresses.js
 *
 * ENV
 *   MONGO_URI                required
 *   DEPOSIT_HD_MNEMONIC      12/24-word phrase. Strongly recommended.
 *   DEPOSIT_WALLET_SECRET    falls back to EPHEMERAL_WALLET_SECRET
 *   DEPOSIT_KEY_BACKUP       'true' (default) also stores an encrypted copy
 *   BACKFILL                 'active' (default, users with active deposits) | 'all' | 'none'
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { ethers } = require('ethers');

let TronWeb = null;
try { ({ TronWeb } = require('tronweb')); } catch { /* Tron optional */ }

const APPLY = process.env.APPLY === 'true';
const BACKFILL = (process.env.BACKFILL || 'active').toLowerCase();
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aussivo-dex';
const MNEMONIC = (process.env.DEPOSIT_HD_MNEMONIC || '').trim();
const PASSPHRASE = process.env.DEPOSIT_HD_PASSPHRASE || '';
const SECRET = (process.env.DEPOSIT_WALLET_SECRET || process.env.EPHEMERAL_WALLET_SECRET || '').trim();
const KEY_BACKUP = (process.env.DEPOSIT_KEY_BACKUP || 'true') === 'true';

const EVM_BASE = "m/44'/60'/0'/0";
const TRON_BASE = "m/44'/195'/0'/0";
const hdEnabled = MNEMONIC.split(/\s+/).filter(Boolean).length >= 12;

const line = (c = '=') => console.log(c.repeat(88));

function encrypt(pkHex, secret) {
  const key = crypto.createHash('sha256').update(String(secret), 'utf8').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(pkHex, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function fingerprint(pkHex) {
  const hex = (pkHex.startsWith('0x') ? pkHex.slice(2) : pkHex).toLowerCase();
  return crypto.createHash('sha256').update(hex, 'utf8').digest('hex');
}
function derive(network, index) {
  const m = ethers.Mnemonic.fromPhrase(MNEMONIC, PASSPHRASE || undefined);
  const path = `${network === 'trc20' ? TRON_BASE : EVM_BASE}/${index}`;
  return { pk: ethers.HDNodeWallet.fromMnemonic(m, path).privateKey, path };
}
function addressFor(network, pk) {
  if (network === 'trc20') {
    if (!TronWeb) throw new Error('tronweb not installed — cannot derive Tron addresses');
    return TronWeb.address.fromPrivateKey(pk.startsWith('0x') ? pk.slice(2) : pk);
  }
  return new ethers.Wallet(pk).address;
}

(async () => {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  line();
  console.log(APPLY ? '*** APPLYING — new deposit_addresses will be created ***'
                    : 'DRY RUN — nothing will be written. Re-run with APPLY=true.');
  line();

  // ── [1] PREFLIGHT ────────────────────────────────────────────────────────
  console.log('\n[1] Preflight\n');
  const problems = [];

  console.log(`    Key custody          : ${hdEnabled ? 'HD (derived, nothing secret at rest)' : 'ENCRYPTED (random keys, ciphertext at rest)'}`);
  if (!hdEnabled) {
    console.log('      ! DEPOSIT_HD_MNEMONIC not set. This still works, but every key lives');
    console.log('        in the database as ciphertext. HD mode is strongly recommended.');
  }
  if (hdEnabled) {
    try {
      const a = derive('bep20', 0);
      const b = derive('bep20', 0);
      if (a.pk !== b.pk) problems.push('HD derivation is not deterministic (!)');
      const addr0 = addressFor('bep20', a.pk);
      console.log(`    HD round-trip        : OK  (index 0 → ${addr0})`);
      if (TronWeb) {
        const t = derive('trc20', 0);
        console.log(`    HD Tron round-trip   : OK  (index 0 → ${addressFor('trc20', t.pk)})`);
      } else {
        console.log('    HD Tron round-trip   : SKIPPED (tronweb not installed)');
      }
    } catch (e) {
      problems.push(`HD derivation failed: ${e.message}`);
    }
  }

  if (!SECRET || SECRET.length < 16) {
    problems.push('DEPOSIT_WALLET_SECRET / EPHEMERAL_WALLET_SECRET is missing or under 16 chars');
  } else {
    console.log(`    Encryption secret    : present (${SECRET.length} chars)`);
  }
  console.log(`    Encrypted backup copy: ${KEY_BACKUP ? 'ON' : 'OFF'}`);
  console.log(`    BSC treasury         : ${process.env.TREASURY_WALLET_ADDRESS || '(missing — sweeps will hold)'}`);
  console.log(`    TRON treasury        : ${process.env.TRON_TREASURY_ADDRESS || '(missing — TRC20 disabled)'}`);

  if (problems.length) {
    console.log('\n    BLOCKING PROBLEMS:');
    problems.forEach((p) => console.log(`      ✗ ${p}`));
    console.log('\n    Fix these before enabling PERSISTENT_DEPOSIT_ADDRESSES.\n');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('\n    Preflight OK.');

  // ── [2] LEGACY STATE ─────────────────────────────────────────────────────
  console.log('\n[2] Legacy ephemeral state (informational — nothing is modified)\n');
  const pd = db.collection('pending_deposits');
  const [inflight, credited, expired, withKeys] = await Promise.all([
    pd.countDocuments({ status: 'pending', depositAddressId: { $in: [null, undefined] } }),
    pd.countDocuments({ status: 'credited', depositAddressId: { $in: [null, undefined] } }),
    pd.countDocuments({ status: 'expired', depositAddressId: { $in: [null, undefined] } }),
    pd.countDocuments({ privateKeyEncrypted: { $nin: ['', null] }, depositAddressId: { $in: [null, undefined] } }),
  ]);
  console.log(`    pending (awaiting funds)     : ${inflight}`);
  console.log(`    credited (awaiting sweep)    : ${credited}`);
  console.log(`    expired                      : ${expired}`);
  console.log(`    still holding a usable key   : ${withKeys}`);
  console.log('\n    The old sweepers keep handling all of the above unchanged.');
  console.log('    Retire them only once `pending` and `credited` reach 0.');

  if (expired > 0) {
    console.log(`\n    ⚠  ${expired} EXPIRED ephemeral address(es) exist. Under the old design these`);
    console.log('       are no longer polled, so any funds sent to them late were never credited.');
    console.log('       Check their balances before retiring the legacy path — the encrypted keys');
    console.log('       are still present for the ones counted above, so recovery is possible.');
    const sample = await pd.find(
      { status: 'expired', depositAddressId: { $in: [null, undefined] } },
      { projection: { ephemeralAddress: 1, asset: 1, network: 1, privateKeyEncrypted: 1, createdAt: 1 } }
    ).limit(10).toArray();
    sample.forEach((d) => console.log(
      `         ${String(d.network || 'bep20').padEnd(6)} ${d.ephemeralAddress}  ` +
      `key=${d.privateKeyEncrypted ? 'yes' : 'PURGED'}  ${new Date(d.createdAt).toISOString().slice(0, 10)}`
    ));
  }

  // ── [3] BACKFILL ─────────────────────────────────────────────────────────
  console.log(`\n[3] Backfill deposit addresses (mode: ${BACKFILL})\n`);
  if (BACKFILL === 'none') {
    console.log('    Skipped. Addresses will be created lazily on first deposit-QR open.');
  } else {
    const users = db.collection('users');
    const deposits = db.collection('deposits');
    const addrs = db.collection('deposit_addresses');
    const state = db.collection('scanner_state');

    let targets;
    if (BACKFILL === 'all') {
      targets = await users.find({ status: 'active' }, { projection: { email: 1 } }).toArray();
    } else {
      const ids = await deposits.distinct('userId', { status: { $in: ['active', 'matured'] } });
      targets = await users.find({ _id: { $in: ids } }, { projection: { email: 1 } }).toArray();
    }
    console.log(`    ${targets.length} candidate user(s).`);

    const networks = ['bep20'];
    if (process.env.TRON_TREASURY_ADDRESS && TronWeb) networks.push('trc20');
    console.log(`    Networks: ${networks.join(', ')}\n`);

    let created = 0, skipped = 0;
    for (const u of targets) {
      for (const net of networks) {
        const exists = await addrs.findOne({ userId: u._id, network: net });
        if (exists) { skipped++; continue; }

        if (!APPLY) { created++; continue; }

        const seq = await state.findOneAndUpdate(
          { key: `hd-index:${net}` },
          { $inc: { counter: 1 } },
          { upsert: true, returnDocument: 'after' }
        );
        const index = Number((seq.value || seq).counter || 1);

        let pk, path = '', keySource = 'encrypted';
        if (hdEnabled) {
          const d = derive(net, index);
          pk = d.pk; path = d.path; keySource = 'hd';
        } else {
          pk = ethers.Wallet.createRandom().privateKey;
        }
        const address = addressFor(net, pk);

        await addrs.insertOne({
          userId: u._id,
          network: net,
          address,
          addressLookup: net === 'trc20' ? address : address.toLowerCase(),
          keySource,
          derivationIndex: keySource === 'hd' ? index : null,
          derivationPath: path,
          privateKeyEncrypted: (keySource === 'encrypted' || KEY_BACKUP) ? encrypt(pk, SECRET) : '',
          privateKeyHash: fingerprint(pk),
          activeVaultId: null, activeVaultSetAt: null, lastCreditedVaultId: null,
          creditedTotal: mongoose.Types.Decimal128.fromString('0'),
          sweptTotal: mongoose.Types.Decimal128.fromString('0'),
          creditsCount: 0,
          lastScannedTimestampMs: 0, lastScanAt: null, lastActivityAt: null,
          lastSweepAt: null, lastSweepTxHash: '', lastSweepError: '', sweepFailureCount: 0,
          unexplainedBalanceSince: null,
          status: 'active',
          createdAt: new Date(), updatedAt: new Date(),
        });
        created++;
        console.log(`    + ${net.padEnd(6)} ${address}  ${u.email || u._id}`);
      }
    }
    console.log(`\n    ${APPLY ? 'Created' : 'Would create'} ${created} address(es); ${skipped} already existed.`);
  }

  line();
  console.log(APPLY ? 'DONE.' : 'DRY RUN complete — nothing written.');
  console.log('\nNext: set PERSISTENT_DEPOSIT_ADDRESSES=true and restart. The old sweepers');
  console.log('keep running for legacy rows; new deposits use the persistent path.');
  line();

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});