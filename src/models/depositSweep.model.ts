import { Schema, model, Types } from "mongoose";

/**
 * deposit_sweeps — one row per treasury sweep from a persistent deposit address.
 *
 * Separate from deposit_credits on purpose: crediting the user and moving funds to
 * treasury are now INDEPENDENT operations. A sweep failing (no gas, RPC down) must
 * never delay or affect the user being credited, and vice versa.
 */
const DepositSweepSchema = new Schema(
  {
    addressId: { type: Types.ObjectId, ref: "deposit_addresses", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "users", required: true, index: true },
    network: { type: String, enum: ["bep20", "trc20"], required: true },
    asset: { type: String, enum: ["USDT", "USDC"], required: true },

    fromAddress: { type: String, required: true },
    toAddress: { type: String, required: true }, // treasury

    amountBaseUnits: { type: String, required: true },
    amount: { type: Number, required: true },

    txHash: { type: String, default: "", index: true },
    /** broadcast → confirmed is a REAL distinction on Tron; totals only move on 'confirmed'. */
    status: {
      type: String,
      enum: ["broadcast", "confirmed", "failed"],
      default: "broadcast",
      index: true,
    },
    error: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

export default model("deposit_sweeps", DepositSweepSchema, "deposit_sweeps");