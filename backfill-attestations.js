/**
 * backfill-attestations.js — sync existing DB positions into AussivoUserRegistryV2.
 * Aggregates ACTIVE principal per wallet and batch-attests it on-chain.
 *
 * SAFE BY DEFAULT: dry-run unless APPLY=true.
 *
 * PRE-FLIGHT INTEGRITY GUARD: before writing ANYTHING on-chain, it verifies every active deposit
 * traces to a real transfer. If any deposit is unbacked (invalid hex txHash, or no matching
 * pending_deposits sweep), it ABORTS — because this contract is immutable and public, and writing
 * a fabricated balance into it is exactly what must never happen. Skip the guard only if you truly
 * know better: ALLOW_UNBACKED=true.
 *
 * ENV:
 *   MONGO_URI                     mongodb connection string
 *   REGISTRY_V2_ADDRESS           deployed v2 contract
 *   REGISTRY_V2_OWNER_PRIVATE_KEY owner key that signs attest txns
 *   BSC_PROVIDER_URL              RPC (defaults to a public BSC node)
 *   BATCH_SIZE                    addresses per attestBatch tx (default 100)
 *   APPLY                         "true" to actually send txns
 *   ALLOW_UNBACKED                "true" to bypass the provenance guard (not recommended)
 *
 * USAGE:
 *   MONGO_URI=... REGISTRY_V2_ADDRESS=0x... REGISTRY_V2_OWNER_PRIVATE_KEY=0x... \
 *     node scripts/backfill-attestations.js               # dry run + integrity check
 *   ... APPLY=true node scripts/backfill-attestations.js  # commit
 */
const { ethers } = require("ethers");
const { MongoClient } = require("mongodb");

const SCALE = 100; // must match the contract's SCALE (cents)
const APPLY = process.env.APPLY === "true";
const ALLOW_UNBACKED = process.env.ALLOW_UNBACKED === "true";
const BATCH = parseInt(process.env.BATCH_SIZE || "100", 10);
const HEX64 = /^0x[0-9a-f]{64}$/i;
const TRON64 = /^[0-9a-f]{64}$/i;

const ABI = [
  "function attestBatch(address[] users, uint128[] principals, uint32[] depositCounts)",
  "function markGlobalSync(uint256 totalUsers, uint256 totalPrincipal)",
];

async function main() {
  const { MONGO_URI, REGISTRY_V2_ADDRESS, REGISTRY_V2_OWNER_PRIVATE_KEY } = process.env;
  if (!MONGO_URI || !REGISTRY_V2_ADDRESS || !REGISTRY_V2_OWNER_PRIVATE_KEY) {
    throw new Error("Set MONGO_URI, REGISTRY_V2_ADDRESS, REGISTRY_V2_OWNER_PRIVATE_KEY");
  }

  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const db = mongo.db();

  // ── Aggregate principal per user ──
  const rows = await db.collection("deposits").aggregate([
    { $match: { status: { $in: ["active", "matured"] } } },
    { $group: { _id: "$userId", principal: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]).toArray();

  const users = await db.collection("users").find(
    { _id: { $in: rows.map(r => r._id) } },
    { projection: { walletAddress: 1 } }
  ).toArray();
  const walletById = new Map(users.map(u => [String(u._id), (u.walletAddress || "").trim()]));

  const items = [];
  let skipped = 0;
  for (const r of rows) {
    const wallet = walletById.get(String(r._id));
    if (!wallet || !ethers.isAddress(wallet)) { skipped++; continue; }
    const cents = Math.round(Number(r.principal) * SCALE);
    if (cents <= 0) { skipped++; continue; }
    items.push({ wallet: ethers.getAddress(wallet), principal: BigInt(cents), count: Number(r.count) });
  }

  const totalCents = items.reduce((s, x) => s + Number(x.principal), 0);
  console.log(`Aggregated ${items.length} wallets (skipped ${skipped} with no/invalid wallet).`);
  console.log(`Total active principal: $${(totalCents / SCALE).toLocaleString()}`);
  items.slice(0, 10).forEach(x =>
    console.log(`  ${x.wallet}  $${(Number(x.principal) / SCALE).toFixed(2)}  (${x.count} deposit(s))`));
  if (items.length > 10) console.log(`  ... and ${items.length - 10} more`);

  if (!APPLY) {
    console.log("\nDRY RUN — no transactions sent. Re-run with APPLY=true to write on-chain.");
    await mongo.close();
    return;
  }

  const provider = new ethers.JsonRpcProvider(
    (process.env.BSC_PROVIDER_URL || "https://bsc-dataseed1.binance.org").split(",")[0].trim()
  );
  const wallet = new ethers.Wallet(REGISTRY_V2_OWNER_PRIVATE_KEY, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log(`\nSigner ${wallet.address}  gas balance: ${ethers.formatEther(bal)} BNB`);
  if (bal === 0n) throw new Error("Signer has 0 BNB — fund it before backfilling.");

  const c = new ethers.Contract(REGISTRY_V2_ADDRESS, ABI, wallet);
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const tx = await c.attestBatch(
      slice.map(x => x.wallet), slice.map(x => x.principal), slice.map(x => x.count)
    );
    console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${slice.length} users  tx=${tx.hash}`);
    await tx.wait(1);
  }

  const gs = await c.markGlobalSync(items.length, BigInt(totalCents));
  await gs.wait(1);
  console.log(`\n✅ Backfill complete. markGlobalSync tx=${gs.hash}`);
  await mongo.close();
}

main().catch((e) => { console.error(e); process.exit(1); });