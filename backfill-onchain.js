/**
 * backfill-onchain.js — one-off: register existing users on-chain and mirror their principal.
 *
 * Reads your database and:
 *   1) REGISTRY: registers the wallet of every user who has an ACTIVE deposit (registerBatch,
 *      idempotent — the contract skips anyone already registered).
 *   2) MIRROR TOKEN (optional): mints the difference between the real total active principal and
 *      the token's current mirroredTotal, so balanceOf(tracker) matches the DB. Safe to re-run
 *      (only mints the gap; never double-mints).
 *
 * SAFETY:
 *   - Dry-run by default. Prints exactly what it would do. Set APPLY=true to send transactions.
 *   - Registry step is always safe/idempotent. Mirror mint only runs with MINT_MIRROR=true.
 *   - Needs BNB in the owner wallet(s) for gas. Uses the SAME env as the backend.
 *
 * RUN (from the backend folder, where .env lives):
 *   node scripts/backfill-onchain.js                         # dry run
 *   APPLY=true node scripts/backfill-onchain.js              # register users only
 *   APPLY=true MINT_MIRROR=true node scripts/backfill-onchain.js   # + mint mirror to match DB
 */
require("dotenv").config();
const { MongoClient } = require("mongodb");
const { ethers } = require("ethers");

const APPLY = process.env.APPLY === "true";
const MINT_MIRROR = process.env.MINT_MIRROR === "true";
const DB_NAME = process.env.MONGO_DB || "test";
const CHUNK = 100;

const {
  MONGO_URI,
  BSC_PROVIDER_URL = "https://bsc-dataseed1.binance.org",
  BSC_CHAIN_ID = "56",
  REGISTRY_CONTRACT_ADDRESS,
  REGISTRY_OWNER_PRIVATE_KEY,
  STAKED_TOKEN_ADDRESS,
  STAKED_TOKEN_OWNER_PRIVATE_KEY,
  STAKED_TOKEN_MEMO = "Aussivo deposit mirror",
} = process.env;

const REGISTRY_ABI = [
  "function registerBatch(address[] users)",
  "function isRegistered(address user) view returns (bool)",
];
const TOKEN_ABI = [
  "function mintForDeposit(uint256 amount, string note)",
  "function mirroredTotal() view returns (uint256)",
];

function provider() {
  const url = String(BSC_PROVIDER_URL).split(",")[0].trim();
  return new ethers.JsonRpcProvider(url, Number(BSC_CHAIN_ID), { staticNetwork: true });
}

async function main() {
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  console.log(`\nDB: ${DB_NAME}   APPLY: ${APPLY}   MINT_MIRROR: ${MINT_MIRROR}\n`);

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  // Active deposits → sum principal, collect userIds.
  const active = await db.collection("deposits").find({ status: "active" }).project({ userId: 1, amount: 1 }).toArray();
  const totalPrincipal = active.reduce((s, d) => s + Number(d.amount || 0), 0);
  const userIds = [...new Set(active.map((d) => String(d.userId)))];

  // Resolve wallet addresses for those users.
  const { ObjectId } = require("mongodb");
  const users = await db.collection("users")
    .find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } })
    .project({ walletAddress: 1 }).toArray();

  const addresses = [...new Set(
    users.map((u) => (u.walletAddress || "").trim())
      .filter((a) => a && ethers.isAddress(a))
      .map((a) => ethers.getAddress(a))
  )];

  console.log(`Active deposits: ${active.length}`);
  console.log(`Users with active deposits: ${userIds.length}`);
  console.log(`Valid wallet addresses to register: ${addresses.length}`);
  console.log(`Total active principal (DB): ${totalPrincipal}`);
  const skippedNoWallet = userIds.length - users.filter((u) => u.walletAddress && ethers.isAddress(u.walletAddress)).length;
  if (skippedNoWallet > 0) console.log(`(${skippedNoWallet} user(s) have no valid wallet address — cannot be registered)`);

  // ── 1) Registry ──
  if (!REGISTRY_CONTRACT_ADDRESS || !REGISTRY_OWNER_PRIVATE_KEY) {
    console.log("\n[Registry] skipped — REGISTRY_CONTRACT_ADDRESS / REGISTRY_OWNER_PRIVATE_KEY not set");
  } else {
    const reg = new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, REGISTRY_ABI, new ethers.Wallet(REGISTRY_OWNER_PRIVATE_KEY, provider()));
    // Filter out already-registered (saves gas).
    const toRegister = [];
    for (const a of addresses) {
      try { if (!(await reg.isRegistered(a))) toRegister.push(a); } catch { toRegister.push(a); }
    }
    console.log(`\n[Registry] ${toRegister.length} address(es) need registering (${addresses.length - toRegister.length} already on-chain)`);
    if (APPLY && toRegister.length) {
      for (let i = 0; i < toRegister.length; i += CHUNK) {
        const batch = toRegister.slice(i, i + CHUNK);
        const tx = await reg.registerBatch(batch);
        console.log(`  registerBatch ${batch.length} → tx=${tx.hash}`);
        await tx.wait(1);
      }
      console.log("  ✅ registry backfill complete");
    } else if (!APPLY) {
      console.log("  DRY RUN — set APPLY=true to send these register transactions");
    }
  }

  // ── 2) Mirror token (optional) ──
  if (MINT_MIRROR) {
    if (!STAKED_TOKEN_ADDRESS || !STAKED_TOKEN_OWNER_PRIVATE_KEY) {
      console.log("\n[Mirror] skipped — STAKED_TOKEN_ADDRESS / STAKED_TOKEN_OWNER_PRIVATE_KEY not set");
    } else {
      const token = new ethers.Contract(STAKED_TOKEN_ADDRESS, TOKEN_ABI, new ethers.Wallet(STAKED_TOKEN_OWNER_PRIVATE_KEY, provider()));
      const onChain = Number(ethers.formatUnits(await token.mirroredTotal(), 18));
      const gap = Math.round((totalPrincipal - onChain) * 1e6) / 1e6;
      console.log(`\n[Mirror] DB principal ${totalPrincipal} · on-chain ${onChain} · gap to mint ${gap}`);
      if (gap > 0) {
        if (APPLY) {
          const units = ethers.parseUnits(gap.toFixed(18), 18);
          const tx = await token.mintForDeposit(units, `${STAKED_TOKEN_MEMO} | backfill`);
          console.log(`  mint ${gap} → tx=${tx.hash}`);
          await tx.wait(1);
          console.log("  ✅ mirror now matches DB");
        } else {
          console.log("  DRY RUN — set APPLY=true to mint the gap");
        }
      } else {
        console.log("  nothing to mint (mirror already ≥ DB principal)");
      }
    }
  } else {
    console.log("\n[Mirror] skipped — set MINT_MIRROR=true to also mint the deposit mirror");
  }

  await client.close();
  console.log("\nDone.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });