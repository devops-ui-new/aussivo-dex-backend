import { Schema, model, Types } from 'mongoose';

const PendingDepositSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'users', required: true, index: true },
  vaultId: { type: Types.ObjectId, ref: 'vaults', required: true, index: true },
  expectedAmount: { type: Number, required: true },
  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  walletAddress: { type: String, required: true, lowercase: true, index: true },
  status: { type: String, enum: ['pending', 'matched', 'expired'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true, index: true },
  matchedTxHash: { type: String, default: '' },
  matchedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

PendingDepositSchema.index({ walletAddress: 1, asset: 1, status: 1 });

export default model('pending_deposits', PendingDepositSchema);
