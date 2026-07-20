import { Schema, model, Types } from "mongoose";

/**
 * deposit_credits — the transfer ledger. ONE row per on-chain inbound transfer.
 *
 * This is what makes deposits exact instead of approximate. The old flow read
 * `balanceOf()` and guessed; a second transfer to the same address, or a sweep
 * racing a deposit, produced wrong numbers. Here each Transfer log becomes one
 * immutable row keyed by (network, txHash, logIndex).
 *
 * IDEMPOTENCY: the unique index below is the entire concurrency story. A duplicate
 * insert throws E11000 and the scanner skips it. Re-scanning the same block range
 * — after a crash, an RPC retry, or a manual replay — is therefore always safe.
 *
 * LIFECYCLE:
 *   detected  → row claimed, accounting not yet applied
 *   credited  → user balance + vault TVL updated, deposit row created
 *   failed    → accounting threw repeatedly; needs a human. Funds are NOT lost:
 *               they are on the deposit address and the key is recoverable.
 */
const DepositCreditSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "users", required: true, index: true },
    addressId: { type: Types.ObjectId, ref: "deposit_addresses", required: true, index: true },
    network: { type: String, enum: ["bep20", "trc20"], required: true },
    asset: { type: String, enum: ["USDT", "USDC"], required: true },

    // ── On-chain identity of this transfer ──
    txHash: { type: String, required: true },
    /** EVM: real log index. Tron: ordinal of the transfer within the tx (usually 0). */
    logIndex: { type: Number, required: true, default: 0 },
    fromAddress: { type: String, default: "" },
    toAddress: { type: String, required: true },
    tokenAddress: { type: String, default: "" },

    // ── Amount, kept in BOTH forms ──
    /** Exact on-chain value. String, never a JS number — 18-dec values exceed 2^53. */
    amountBaseUnits: { type: String, required: true },
    /** Human amount used for accounting (matches the existing deposits.amount). */
    amount: { type: Number, required: true },
    decimals: { type: Number, required: true },

    blockNumber: { type: Number, default: 0 },
    blockTimestampMs: { type: Number, default: 0 },

    // ── Resolution ──
    vaultId: { type: Types.ObjectId, ref: "vaults", default: null },
    depositId: { type: Types.ObjectId, ref: "deposits", default: null },
    /** The pending_deposits "session" this satisfied, if the user had one open. */
    pendingDepositId: { type: Types.ObjectId, ref: "pending_deposits", default: null },
    /** Mirrors deposits.pendingRequestId — reuses the EXISTING unique index there. */
    requestId: { type: String, default: "" },

    status: {
      type: String,
      enum: ["detected", "credited", "failed"],
      default: "detected",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    creditedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

/** THE idempotency guarantee. Do not remove. */
DepositCreditSchema.index({ network: 1, txHash: 1, logIndex: 1 }, { unique: true });
DepositCreditSchema.index({ status: 1, createdAt: 1 });

export default model("deposit_credits", DepositCreditSchema, "deposit_credits");