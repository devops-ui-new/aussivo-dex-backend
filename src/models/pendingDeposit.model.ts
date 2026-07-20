import { Schema, model, Types } from "mongoose";

const PendingDepositSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "users", required: true, index: true },
    vaultId: { type: Types.ObjectId, ref: "vaults", required: true, index: true },
    expectedAmount: { type: Number, required: true },
    expectedAmountBaseUnits: { type: String, required: true, index: true },
    requestId: { type: String, required: true, index: true },
    asset: { type: String, enum: ["USDT", "USDC"], required: true },
    /** Which chain the deposit address is on. bep20 = BSC/EVM, trc20 = Tron. */
    network: { type: String, enum: ["bep20", "trc20"], default: "bep20", index: true },
    /** Set when this intent points at a PERSISTENT deposit address (deposit_addresses).
     *  Legacy ephemeral rows never have it — that is how the two sweepers stay separated. */
    depositAddressId: { type: Types.ObjectId, ref: "deposit_addresses", default: null, index: true },
    /** Legacy: user wallet hint for old vault-contract flow. Optional for ephemeral deposits. */
    walletAddress: { type: String, default: "", lowercase: true, index: true },
    /** One-time deposit address (QR); funds swept to treasury after detection.
     *  NOT lowercased at schema level — EVM addresses are lowercased in code, Tron base58 is case-sensitive. */
    ephemeralAddress: { type: String, required: true, index: true },
    /** Open-amount intent: no expected amount — capture & credit whatever the user sends, fast. */
    openAmount: { type: Boolean, default: false },
    /** Wallets observed sending token transfers to the ephemeral address (audit trail). */
    depositorAddresses: { type: [String], default: [] },
    /** AES-GCM ciphertext (base64). Removed after successful treasury sweep. */
    privateKeyEncrypted: { type: String, required: false, default: "" },
    /** SHA-256 hex fingerprint of the private key (audit only; not reversible). Kept after sweep. */
    privateKeyHash: { type: String, default: "", index: true },
    gasFundTxHash: { type: String, default: "" },
    energyFundedAt: { type: Date }, // last time TRX energy was sent to a Tron ephemeral (fund cooldown)
    energyFundAttempts: { type: Number, default: 0 }, // how many times we've topped up energy (cap to avoid draining funder)
    fundingHalted: { type: Boolean, default: false }, // stop funding after too many failed attempts (needs manual review)
    /**
     * pending = waiting for USDT; credited = user portfolio updated, sweep may be pending;
     * matched = sweep done + key material purged; expired = timed out with no payment.
     */
    status: {
      type: String,
      enum: ["pending", "credited", "matched", "expired"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    /** First time user dismissed QR/cancelled from UI. Tracking still continues until expiry. */
    userDismissedAt: { type: Date, default: null },
    /** Actual token amount detected on ephemeral wallet after expiry window. */
    receivedAmount: { type: Number, default: 0 },
    receivedAmountBaseUnits: { type: String, default: "" },
    /** Set when stablecoin balance is sufficient and user/vault accounting has been applied. */
    userCreditedAt: { type: Date, default: null },
    /** First tick we saw token on the ephemeral wallet during the intent window; used to send “incoming” email once. */
    incomingFundsNotifiedAt: { type: Date, default: null },
    /** Last on-chain balance (base units) we emailed about; used to detect new transfers during the window. */
    incomingFundsLastNotifiedBalanceBaseUnits: { type: String, default: "" },
    /** Treasury sweep tx (funds moved off ephemeral). */
    matchedTxHash: { type: String, default: "" },
    matchedAt: { type: Date, default: null },
    sweepTxHash: { type: String, default: "" },
    /** When decryptable private key material was removed from this document. */
    keyPurgedAt: { type: Date, default: null },

    /** Mirrors deposits.excludedFromAccounting — keeps the sweep views consistent. */
    excludedFromAccounting: { type: Boolean, default: false, index: true },
    excludedReason: { type: String, default: "" },
    excludedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

PendingDepositSchema.index({ ephemeralAddress: 1, asset: 1, status: 1 });
PendingDepositSchema.index({ requestId: 1, status: 1 });

export default model("pending_deposits", PendingDepositSchema);