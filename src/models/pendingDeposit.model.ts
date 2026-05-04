import { Schema, model, Types } from "mongoose";

const PendingDepositSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "users", required: true, index: true },
    vaultId: { type: Types.ObjectId, ref: "vaults", required: true, index: true },
    expectedAmount: { type: Number, required: true },
    expectedAmountBaseUnits: { type: String, required: true, index: true },
    requestId: { type: String, required: true, index: true },
    asset: { type: String, enum: ["USDT", "USDC"], required: true },
    /** Legacy: user wallet hint for old vault-contract flow. Optional for ephemeral deposits. */
    walletAddress: { type: String, default: "", lowercase: true, index: true },
    /** One-time deposit address (QR); funds swept to treasury after detection. */
    ephemeralAddress: { type: String, required: true, lowercase: true, index: true },
    /** AES-GCM ciphertext (base64). Removed after successful treasury sweep. */
    privateKeyEncrypted: { type: String, required: false, default: "" },
    /** SHA-256 hex fingerprint of the private key (audit only; not reversible). Kept after sweep. */
    privateKeyHash: { type: String, default: "", index: true },
    gasFundTxHash: { type: String, default: "" },
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
    /** Set when stablecoin balance is sufficient and user/vault accounting has been applied. */
    userCreditedAt: { type: Date, default: null },
    /** Treasury sweep tx (funds moved off ephemeral). */
    matchedTxHash: { type: String, default: "" },
    matchedAt: { type: Date, default: null },
    sweepTxHash: { type: String, default: "" },
    /** When decryptable private key material was removed from this document. */
    keyPurgedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

PendingDepositSchema.index({ ephemeralAddress: 1, asset: 1, status: 1 });
PendingDepositSchema.index({ requestId: 1, status: 1 });

export default model("pending_deposits", PendingDepositSchema);
