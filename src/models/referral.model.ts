import { Schema, model, Types } from 'mongoose';

const ReferralSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'users', required: true, index: true },
  referrerId: { type: Types.ObjectId, ref: 'users', required: true, index: true },
  level: { type: Number, enum: [1, 2], required: true },
  totalEarned: { type: Number, default: 0 },
}, { timestamps: true });

ReferralSchema.index({ referrerId: 1, level: 1 });
export default model('referrals', ReferralSchema);
