import { Schema, model, Types } from 'mongoose';

const WithdrawRequestSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'users', required: true, index: true },
  amount: { type: Number, required: true },        // GROSS — the amount debited from the user's balance
  fee: { type: Number, default: 0 },               // early-exit fee (1% if before 30d) retained by treasury
  netAmount: { type: Number, default: 0 },         // what the user actually receives on-chain (amount − fee)
  early: { type: Boolean, default: false },         // withdrawn before the 30-day mark?
  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  walletAddress: { type: String, required: true },
  source: { type: String, enum: ['yield', 'deposit', 'referral'], required: true },
  depositId: { type: Types.ObjectId, ref: 'deposits', default: null, index: true },
  txHash: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'completed'], default: 'pending' },
  reviewedBy: { type: Types.ObjectId, ref: 'admins', default: null },
  reviewNote: { type: String, default: '' },
}, { timestamps: true });

export default model('withdraw-requests', WithdrawRequestSchema);