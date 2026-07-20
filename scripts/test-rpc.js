/**
 * test-rpc.js — find a BSC RPC that actually serves eth_getLogs.
 *
 * The deposit scanner needs eth_getLogs with a token address + indexed-topic filter.
 * Most free "dataseed" endpoints answer eth_blockNumber fine but refuse, throttle, or
 * 403 on getLogs — which is exactly the failure you hit. This runs the real query
 * against each candidate and tells you which ones work.
 *
 * USAGE
 *   node scripts/test-rpc.js
 *   node scripts/test-rpc.js https://your-endpoint    # test a specific one too
 */
const { ethers } = require("ethers");

const EXTRA = process.argv.slice(2);
const CANDIDATES = [
  ...EXTRA,
  "https://bsc-rpc.publicnode.com",
  "https://bsc.drpc.org",
  "https://1rpc.io/bnb",
  "https://bsc-mainnet.public.blastapi.io",
  "https://binance.llamarpc.com",
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed1.binance.org",
];

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
// An address that definitely receives USDT, so a working node returns real logs.
const PROBE = "0x0000000000000000000000000000000000000000";
const topicFor = (a) => `0x000000000000000000000000${a.toLowerCase().replace(/^0x/, "")}`;

(async () => {
  console.log("=".repeat(78));
  console.log("Testing BSC RPC endpoints for eth_getLogs support");
  console.log("=".repeat(78));

  const working = [];

  for (const url of CANDIDATES) {
    process.stdout.write(`\n${url}\n`);
    let provider;
    try {
      provider = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true });
    } catch (e) {
      console.log(`   ✗ bad URL: ${e.message}`);
      continue;
    }

    // 1. Basic reachability
    let head;
    const t0 = Date.now();
    try {
      head = await provider.getBlockNumber();
      console.log(`   ✓ reachable       block ${head}  (${Date.now() - t0}ms)`);
    } catch (e) {
      console.log(`   ✗ unreachable     ${e.shortMessage || e.message}`);
      continue;
    }

    // 2. The query that actually matters — 1000 blocks, token + topic filter.
    const t1 = Date.now();
    try {
      const logs = await provider.getLogs({
        address: USDT,
        topics: [TRANSFER, null, [topicFor(PROBE)]],
        fromBlock: head - 1000,
        toBlock: head - 12,
      });
      console.log(`   ✓ getLogs 1000blk ${logs.length} log(s)  (${Date.now() - t1}ms)  <-- USABLE`);
      working.push({ url, ms: Date.now() - t1 });
    } catch (e) {
      const msg = e.shortMessage || e.message || String(e);
      console.log(`   ✗ getLogs FAILED  ${msg.slice(0, 90)}`);
      continue;
    }

    // 3. Wider range — tells you whether you can raise DEPOSIT_SCAN_CHUNK_BLOCKS.
    try {
      const t2 = Date.now();
      await provider.getLogs({
        address: USDT,
        topics: [TRANSFER, null, [topicFor(PROBE)]],
        fromBlock: head - 5000,
        toBlock: head - 12,
      });
      console.log(`   ✓ getLogs 5000blk ok  (${Date.now() - t2}ms)`);
    } catch {
      console.log(`   · getLogs 5000blk rejected — keep DEPOSIT_SCAN_CHUNK_BLOCKS at 1000`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  if (!working.length) {
    console.log("No endpoint served getLogs. Options:");
    console.log("  • Sign up for a free key — Ankr, BlockPI, NodeReal, QuickNode, dRPC");
    console.log("  • Some providers block cloud/VPN IPs; try from a different network");
    console.log("  • Railway's egress IP may be blocked where your laptop is not — test there too");
  } else {
    working.sort((a, b) => a.ms - b.ms);
    console.log("WORKING ENDPOINTS (fastest first):\n");
    working.forEach((w, i) => console.log(`  ${i + 1}. ${w.url}   ${w.ms}ms`));
    console.log(`\nPut this in .env:\n\n  BSC_PROVIDER_URL=${working.map((w) => w.url).slice(0, 2).join(",")}\n`);
    console.log("Only services that split on comma use the fallback. If you want zero");
    console.log("ambiguity, use the single fastest URL on its own.");
  }
  console.log("=".repeat(78));
})();