import { Schema, model, Types } from 'mongoose';

const WithdrawRequestSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'users', required: true, index: true },
  amount: { type: Number, required: true },
  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  walletAddress: { type: String, required: true },
  source: { type: String, enum: ['yield', 'deposit', 'referral'], required: true },
  txHash: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'completed'], default: 'pending' },
  reviewedBy: { type: Types.ObjectId, ref: 'admins', default: null },
  reviewNote: { type: String, default: '' },
}, { timestamps: true });

export default model('withdraw-requests', WithdrawRequestSchema);
