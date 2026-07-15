/**
 * allocationModel — ILLUSTRATIVE, deterministic, wall-clock-based strategy allocation.
 * =====================================================================================
 * Backend source of truth. Given a vault and the current time it produces a *target
 * allocation model*: a set of DeFi constituents, each with a precise weight (summing to
 * exactly 100%), a plausible drifting APY, a colour and a status. Weights and APYs
 * breathe over time and constituents rotate at each "rebalance" — all 100% deterministic
 * (pure function of vault seed + wall clock), so every client and every server instance
 * agrees to the decimal without any stored state.
 *
 * WHY IT LIVES IN THE BACKEND
 *   - One source of truth for the numbers (frontend just renders + polls).
 *   - The real `protocol` / `contract` per venue live here already (see VaultStrategy),
 *     so the swap to real on-chain positions is a one-function change (see README).
 *
 * HONESTY / POSITIONING
 *   This is a TARGET MODEL, not a live on-chain position report. It must render under the
 *   existing "Illustrative" badge + disclaimer. Protocol names indicate the strategy's
 *   *intended venues*, not a claim that capital is presently deployed there. Enable it
 *   only when ALLOC_LIVE_MODEL === true (demo), same spirit as the frontend demoDrift.
 *
 * SWAPPING IN REAL CONTRACTS LATER
 *   Two paths, both keep the same output shape:
 *     1) Fill `contract` on each CATALOG venue (or on the vault's stored strategies) and
 *        keep generating target weights.
 *     2) Replace `computeVaultAllocation` with a reader that pulls live positions from
 *        those contracts / a subgraph and returns the identical shape. Nothing else
 *        changes (formatVault, the /allocation endpoint, the whole frontend).
 * =====================================================================================
 */

/* Fixed anchor so the model is stable across restarts/redeploys (mirrors demoDrift.js). */
const EPOCH = Date.UTC(2026, 6, 2); // 2 Jul 2026

/* ────────────────────────────── types ────────────────────────────── */

export interface AllocStrategy {
  name: string;
  /** numeric weight in %, to `decimals` places; the set sums to exactly 100 */
  allocation: number;
  /** kept for frontends that read `pct` directly */
  pct: number;
  protocol: string;
  category: string;
  color: string;
  /** display yield label, e.g. "5.3%" or "—" for reserve legs */
  apy: string;
  /** numeric yield (0 for reserve) — handy for blended-APY maths */
  apyNum: number;
  status: string;
  /** 2-letter avatar code */
  code: string;
  /** real venue address / subgraph id — empty until wired to contracts */
  contract: string;
}

export interface AllocResult {
  strategies: AllocStrategy[];
  blendedApy: number;
  epoch: number;
  rebalancePeriodMs: number;
  msToNextRebalance: number;
  themeLabel: string;
}

export interface AllocOptions {
  now?: number;
  rebalancePeriodMs?: number;
  decimals?: number;
  reserveTarget?: number;
  reserveBand?: number;
  driftAmp?: number;
  activeCount?: number;
}

/** Minimal vault shape this model needs. */
export interface AllocVaultLike {
  id?: string;
  _id?: unknown;
  name?: string;
  /** optional admin pin: one of THEME_KEYS */
  strategyTheme?: string;
}

/* ──────────────────────── deterministic primitives ──────────────────────── */

/** FNV-1a string hash → uint32. Stable, fast, dependency-free. */
function hashStr(str: string): number {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** mulberry32 PRNG from a numeric seed → () => [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth, slow, deterministic noise in ~[-1, 1] from continuous time (no per-tick RNG). */
function smoothNoise(t: number, phase: number): number {
  return 0.62 * Math.sin(t * 0.11 + phase) + 0.38 * Math.sin(t * 0.037 + phase * 1.7);
}

/** Quantise raw weights to `decimals` places so they sum to EXACTLY 100 (largest remainder). */
function quantizeTo100(rawWeights: number[], decimals = 1): number[] {
  const u = Math.pow(10, decimals);
  const target = Math.round(100 * u);
  const sum = rawWeights.reduce((a, b) => a + b, 0) || 1;

  const scaled = rawWeights.map((w) => (w * 100 * u) / sum);
  const floors = scaled.map((x) => Math.floor(x));
  let remainder = target - floors.reduce((a, b) => a + b, 0);

  const order = scaled
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);

  const out = floors.slice();
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) out[order[k]!.i] += 1;
  for (let k = order.length - 1; remainder < 0 && k >= 0; k--, remainder++) out[order[k]!.i] -= 1;

  return out.map((v) => v / u);
}

/* ───────────────────────────── protocol catalog ─────────────────────────────
 * Prominent, real DeFi venues. `code` is the 2-letter avatar. `apy` drives the drifting
 * display yield (reserve legs use apy:null). `contract` is the real-data swap-in slot.
 * ──────────────────────────────────────────────────────────────────────────── */
interface CatalogEntry {
  name: string;
  code: string;
  protocol: string;
  category: string;
  color: string;
  apy: { base: number; amp: number; floor: number } | null;
  status?: string;
  contract: string;
}

export const CATALOG: Record<string, CatalogEntry> = {
  aave:      { name: "Aave V3 Lending",        code: "Aa", protocol: "Aave",       category: "Lending",         color: "#00D395", apy: { base: 5.3,  amp: 1.4, floor: 2 }, contract: "" },
  compound:  { name: "Compound Finance",       code: "Co", protocol: "Compound",   category: "Lending",         color: "#0E8F6E", apy: { base: 4.6,  amp: 1.2, floor: 2 }, contract: "" },
  morpho:    { name: "Morpho Blue",            code: "Mo", protocol: "Morpho",     category: "Lending",         color: "#5C6CFF", apy: { base: 6.2,  amp: 1.7, floor: 2 }, contract: "" },
  spark:     { name: "Spark Protocol",         code: "Sp", protocol: "Spark",      category: "Lending",         color: "#F5AC37", apy: { base: 5.6,  amp: 1.1, floor: 2 }, contract: "" },
  fluid:     { name: "Fluid Lending",          code: "Fl", protocol: "Fluid",      category: "Lending",         color: "#3B82F6", apy: { base: 5.9,  amp: 1.6, floor: 2 }, contract: "" },
  venus:     { name: "Venus Protocol",         code: "Ve", protocol: "Venus",      category: "Lending",         color: "#E8B10A", apy: { base: 5.8,  amp: 1.7, floor: 2 }, contract: "" },
  sky:       { name: "Sky Savings Rate",       code: "Sk", protocol: "Sky",        category: "Savings",         color: "#1AAB9B", apy: { base: 6.3,  amp: 0.9, floor: 3 }, contract: "" },

  curve:     { name: "Curve Stableswap",       code: "Cu", protocol: "Curve",      category: "Stable LP",       color: "#3457D5", apy: { base: 6.4,  amp: 2.0, floor: 2 }, contract: "" },
  convex:    { name: "Convex Finance",         code: "Cv", protocol: "Convex",     category: "Boosted LP",      color: "#A64EF6", apy: { base: 8.3,  amp: 2.4, floor: 2 }, contract: "" },
  balancer:  { name: "Balancer Boosted",       code: "Ba", protocol: "Balancer",   category: "Weighted LP",     color: "#8A8F98", apy: { base: 6.7,  amp: 2.1, floor: 2 }, contract: "" },
  uniswap:   { name: "Uniswap V3 LP",          code: "Un", protocol: "Uniswap",    category: "Concentrated LP", color: "#FF2E9A", apy: { base: 9.1,  amp: 3.4, floor: 1 }, contract: "" },

  pendle:    { name: "Pendle Fixed Yield",     code: "Pe", protocol: "Pendle",     category: "Fixed Yield",     color: "#2FB5A8", apy: { base: 9.7,  amp: 2.2, floor: 3 }, contract: "" },
  ethena:    { name: "Ethena sUSDe",           code: "Et", protocol: "Ethena",     category: "Delta-Neutral",   color: "#7C5CFF", apy: { base: 11.6, amp: 4.2, floor: 4 }, contract: "" },
  funding:   { name: "Funding Rate Arbitrage", code: "Fu", protocol: "Perps",      category: "Delta-Neutral",   color: "#B6509E", apy: { base: 12.8, amp: 5.0, floor: 3 }, contract: "" },
  gmx:       { name: "GMX Liquidity (GLP)",    code: "GM", protocol: "GMX",        category: "Perps LP",        color: "#2A5ADA", apy: { base: 10.3, amp: 3.8, floor: 3 }, contract: "" },

  lido:      { name: "Lido Staked ETH",        code: "Li", protocol: "Lido",       category: "LST",             color: "#00A3FF", apy: { base: 3.4,  amp: 0.5, floor: 2 }, contract: "" },
  rocket:    { name: "Rocket Pool ETH",        code: "Ro", protocol: "RocketPool", category: "LST",             color: "#FF6B6B", apy: { base: 3.6,  amp: 0.6, floor: 2 }, contract: "" },
  etherfi:   { name: "EtherFi Restaked",       code: "Ef", protocol: "EtherFi",    category: "Restaking",       color: "#2FE0C0", apy: { base: 4.2,  amp: 0.9, floor: 2 }, contract: "" },

  ondo:      { name: "Ondo OUSG (RWA)",        code: "On", protocol: "Ondo",       category: "RWA T-Bills",     color: "#3B6FE0", apy: { base: 5.1,  amp: 0.5, floor: 4 }, contract: "" },
  maple:     { name: "Maple Direct (RWA)",     code: "Ma", protocol: "Maple",      category: "RWA Credit",      color: "#F26D5B", apy: { base: 8.4,  amp: 1.6, floor: 4 }, contract: "" },

  // Reserve / buffer legs — always "Liquid", no yield.
  insurance: { name: "Insurance Reserve",      code: "In", protocol: "Internal",   category: "Reserve",         color: "#F59E0B", apy: null, status: "Liquid", contract: "" },
  buffer:    { name: "Reserve Buffer",         code: "Re", protocol: "Internal",   category: "Reserve",         color: "#F5A623", apy: null, status: "Liquid", contract: "" },
};

/* ───────────────────────────────── themes ───────────────────────────────── */
interface Theme { core: string[]; bench: string[]; reserve: string; label: string; }

export const THEMES: Record<string, Theme> = {
  "stable-lending": { core: ["aave", "compound", "morpho"], bench: ["spark", "venus", "fluid", "sky"], reserve: "buffer",    label: "Stablecoin Lending" },
  "delta-neutral":  { core: ["funding", "ethena", "aave"],  bench: ["curve", "convex", "pendle"],      reserve: "insurance", label: "Market-Neutral" },
  "bluechip-lp":    { core: ["uniswap", "curve", "convex"], bench: ["balancer", "pendle", "gmx"],      reserve: "buffer",    label: "Blue-Chip Liquidity" },
  "lsd-staking":    { core: ["lido", "rocket", "etherfi"],  bench: ["pendle", "aave", "morpho"],       reserve: "buffer",    label: "Staking & Restaking" },
  "rwa-yield":      { core: ["ondo", "maple", "sky"],       bench: ["aave", "spark", "morpho"],        reserve: "buffer",    label: "Real-World Assets" },
};
export const THEME_KEYS = Object.keys(THEMES);

/** Explicit overrides so the seeded demo vaults keep their described character. */
const NAME_THEME: Record<string, string> = {
  cryptobluechip: "stable-lending",
  defitracker: "delta-neutral",
};

/** Resolve a theme for any vault — admin pin, then name map, then deterministic by seed. */
export function themeForVault(vault: AllocVaultLike): string {
  if (vault?.strategyTheme && THEMES[vault.strategyTheme]) return vault.strategyTheme;
  const name = String(vault?.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (NAME_THEME[name]) return NAME_THEME[name]!;
  const seed = String(vault?.id ?? vault?._id ?? vault?.name ?? "pool");
  return THEME_KEYS[hashStr(seed + "|theme") % THEME_KEYS.length]!;
}

/* ─────────────────────── epoch plan (per rebalance) ─────────────────────── */
interface EpochPlan { members: string[]; baseRaw: number[]; reserveKey: string; reserveTarget: number; themeLabel: string; }

function epochPlan(seed: string, theme: string, epoch: number, opts: Required<Omit<AllocOptions, "now" | "activeCount">> & { activeCount?: number }): EpochPlan {
  const t = THEMES[theme] || THEMES["stable-lending"]!;
  const rng = mulberry32(hashStr(`${seed}|${theme}|${epoch}`));

  const universe = Array.from(new Set([...t.core, ...t.bench]));
  let active = opts.activeCount ?? 0;
  if (!active) {
    active = 3 + (hashStr(`${seed}|ac`) % 2);
    if (universe.length >= 5 && epoch % 4 === 3) active += 1;
  }
  active = Math.max(2, Math.min(active, universe.length));

  const anchor = t.core[0]!;
  const rest = universe
    .filter((k) => k !== anchor)
    .map((k) => ({ k, key: hashStr(`${k}|${epoch}|${seed}`) }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.k);
  const members = [anchor, ...rest.slice(0, active - 1)];

  const baseRaw = members.map((_, i) => Math.pow(0.72, i) * (0.85 + rng() * 0.3));
  const reserveTarget = opts.reserveTarget + (rng() * 2 - 1) * opts.reserveBand;

  const orderIdx = baseRaw.map((w, i) => ({ i, w })).sort((a, b) => b.w - a.w).map((x) => x.i);

  return {
    members: orderIdx.map((i) => members[i]!),
    baseRaw: orderIdx.map((i) => baseRaw[i]!),
    reserveKey: t.reserve,
    reserveTarget: Math.max(4, Math.min(20, reserveTarget)),
    themeLabel: t.label,
  };
}

/* ─────────────────────────────── public API ─────────────────────────────── */

/**
 * buildAllocation — the illustrative allocation for a vault at time `now`.
 * Pass a vault-like object ({ id/_id/name/strategyTheme }) or a seed string.
 */
export function buildAllocation(vault: AllocVaultLike | string, options: AllocOptions = {}): AllocResult {
  const opts = {
    now: options.now ?? Date.now(),
    rebalancePeriodMs: options.rebalancePeriodMs ?? 24 * 60 * 60 * 1000,
    decimals: options.decimals ?? 1,
    reserveTarget: options.reserveTarget ?? 10,
    reserveBand: options.reserveBand ?? 2,
    driftAmp: options.driftAmp ?? 1.2,
    activeCount: options.activeCount,
  };

  const v: AllocVaultLike = typeof vault === "string" ? { name: vault } : vault;
  const seed = String(v.id ?? v._id ?? v.name ?? "pool");
  const theme = themeForVault(v);

  const t = Math.max(0, (opts.now - EPOCH) / 1000);
  const epoch = Math.floor((opts.now - EPOCH) / opts.rebalancePeriodMs);
  const plan = epochPlan(seed, theme, epoch, opts);

  const legPhases = plan.members.map((k) => (hashStr(k + "|wp") % 628) / 100);
  const driftedLegRaw = plan.baseRaw.map((w, i) => {
    const wiggle = opts.driftAmp * smoothNoise(t, legPhases[i]!);
    return Math.max(0.5, w * 10 + wiggle);
  });

  const reserveWeight = Math.max(3, plan.reserveTarget + opts.driftAmp * 0.5 * smoothNoise(t, 4.2));

  const legShareTotal = 100 - reserveWeight;
  const legSum = driftedLegRaw.reduce((a, b) => a + b, 0) || 1;
  const rawWeights = [...driftedLegRaw.map((w) => (w / legSum) * legShareTotal), reserveWeight];
  const pcts = quantizeTo100(rawWeights, opts.decimals);

  const strategies: AllocStrategy[] = plan.members.map((key, i) => {
    const c = CATALOG[key]!;
    const apyPhase = (hashStr(key + "|ap") % 628) / 100;
    const apyNum = c.apy ? Math.max(c.apy.floor, c.apy.base + c.apy.amp * smoothNoise(t, apyPhase)) : null;
    return {
      name: c.name,
      allocation: pcts[i]!,
      pct: pcts[i]!,
      protocol: c.protocol,
      category: c.category,
      color: c.color,
      apy: apyNum == null ? "—" : `${apyNum.toFixed(1)}%`,
      apyNum: apyNum ?? 0,
      status: c.status || "Active",
      code: c.code,
      contract: c.contract,
    };
  });

  const rc = CATALOG[plan.reserveKey]!;
  const rpct = pcts[pcts.length - 1]!;
  strategies.push({
    name: rc.name,
    allocation: rpct,
    pct: rpct,
    protocol: rc.protocol,
    category: rc.category,
    color: rc.color,
    apy: "—",
    apyNum: 0,
    status: "Liquid",
    code: rc.code,
    contract: rc.contract,
  });

  const blendedApy = strategies.reduce((a, s) => a + (s.pct / 100) * s.apyNum, 0);
  const msToNextRebalance =
    opts.rebalancePeriodMs - (((opts.now - EPOCH) % opts.rebalancePeriodMs) + opts.rebalancePeriodMs) % opts.rebalancePeriodMs;

  return {
    strategies,
    blendedApy: Number(blendedApy.toFixed(2)),
    epoch,
    rebalancePeriodMs: opts.rebalancePeriodMs,
    msToNextRebalance,
    themeLabel: plan.themeLabel,
  };
}

export default buildAllocation;