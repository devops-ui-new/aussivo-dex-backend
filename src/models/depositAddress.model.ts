import { Schema, model, Types } from "mongoose";

/**
 * deposit_addresses — ONE permanent deposit address per (user, network).
 *
 * Replaces the throwaway per-intent ephemeral wallet. Because the address never
 * expires and its key is never purged:
 *   • funds that arrive late (after a QR "expires") are still detected and credited
 *   • funds that arrive as several transfers are each credited individually
 *   • funds stranded for any reason are ALWAYS sweepable — the key is recoverable
 *
 * Money safety invariant (enforced in persistentSweep.service.ts):
 *
 *     onAddressExpected = creditedTotal - sweptTotal
 *     sweepable         = min(actualBalance, onAddressExpected)
 *
 * i.e. we NEVER sweep value that has not yet been credited to the user. If the
 * balance exceeds what we've credited, the scanner is behind — we wait rather
 * than move a user's money into treasury without booking it.
 */
const DepositAddressSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "users", required: true, index: true },

    /** bep20 = BSC/EVM (18-dec USDT/USDC) · trc20 = Tron (6-dec USDT) */
    network: { type: String, enum: ["bep20", "trc20"], required: true, index: true },

    /** Display form: checksummed 0x… for EVM, base58 T… for Tron. */
    address: { type: String, required: true },
    /** Canonical lookup form: lowercased for EVM, verbatim for Tron (case-sensitive). */
    addressLookup: { type: String, required: true, index: true },

    // ── Key custody ────────────────────────────────────────────────────────
    /** 'hd' = derived from master mnemonic (nothing secret stored here).
     *  'encrypted' = AES-256-GCM ciphertext below is the only copy. */
    keySource: { type: String, enum: ["hd", "encrypted"], required: true },
    derivationIndex: { type: Number, default: null },
    derivationPath: { type: String, default: "" },
    /** NEVER unset. There is deliberately no keyPurgedAt field on this model. */
    privateKeyEncrypted: { type: String, default: "" },
    /** SHA-256 fingerprint of the key — audit only, not reversible. */
    privateKeyHash: { type: String, default: "", index: true },

    // ── Vault attribution ──────────────────────────────────────────────────
    /** Vault an incoming transfer is credited into when no open intent matches.
     *  Set every time the user opens a deposit QR. Guarantees funds always land
     *  somewhere sensible instead of being dropped. */
    activeVaultId: { type: Types.ObjectId, ref: "vaults", default: null },
    activeVaultSetAt: { type: Date, default: null },
    /** Last vault actually credited — the fallback of last resort. */
    lastCreditedVaultId: { type: Types.ObjectId, ref: "vaults", default: null },

    // ── Running totals (base units, Decimal128 so 18-dec values are exact) ──
    creditedTotal: { type: Schema.Types.Decimal128, default: "0" },
    sweptTotal: { type: Schema.Types.Decimal128, default: "0" },
    creditsCount: { type: Number, default: 0 },

    // ── Scanner cursors ────────────────────────────────────────────────────
    /** Tron only: last block_timestamp (ms) consumed from TronGrid for this address. */
    lastScannedTimestampMs: { type: Number, default: 0 },
    lastScanAt: { type: Date, default: null },
    /** Drives tiered polling: hot addresses are scanned every tick. */
    lastActivityAt: { type: Date, default: null },

    // ── Sweep health ───────────────────────────────────────────────────────
    lastSweepAt: { type: Date, default: null },
    lastSweepTxHash: { type: String, default: "" },
    lastSweepError: { type: String, default: "" },
    sweepFailureCount: { type: Number, default: 0 },
    /** Set when balance exceeds credited total for a sustained period — means the
     *  scanner missed an inflow. Surfaces in the admin monitor; blocks auto-sweep
     *  of the unexplained excess (never the credited portion). */
    unexplainedBalanceSince: { type: Date, default: null },

    status: { type: String, enum: ["active", "retired"], default: "active", index: true },
  },
  { timestamps: true, versionKey: false }
);

/** One address per user per chain. This is the guarantee the whole design rests on. */
DepositAddressSchema.index({ userId: 1, network: 1 }, { unique: true });
/** Address must be globally unique across all users. */
DepositAddressSchema.index({ network: 1, addressLookup: 1 }, { unique: true });

export default model("deposit_addresses", DepositAddressSchema, "deposit_addresses");