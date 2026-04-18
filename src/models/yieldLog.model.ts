import { Schema, model, Types } from 'mongoose';

const YieldLogSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'users', required: true, index: true },
  depositId: { type: Types.ObjectId, ref: 'deposits', required: true },
  vaultId: { type: Types.ObjectId, ref: 'vaults', required: true },
  amount: { type: Number, required: true },
  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  apyPercent: { type: Number, required: true },
  depositAmount: { type: Number, required: true },
  paymentNumber: { type: Number, required: true },  // which month payment (1, 2, 3...)
  source: { type: String, enum: ['vault_apy', 'referral_l1', 'referral_l2'], required: true },
  referredUserId: { type: Types.ObjectId, ref: 'users', default: null },  // who generated this referral yield
}, { timestamps: true, versionKey: false });

YieldLogSchema.index({ userId: 1, createdAt: -1 });
YieldLogSchema.index({ depositId: 1, paymentNumber: 1 });
export default model('yield-logs', YieldLogSchema);
