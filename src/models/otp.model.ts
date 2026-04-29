import { Schema, model, Types } from 'mongoose';

const OtpSchema = new Schema({
  userId: { type: Types.ObjectId, required: true },
  email: { type: String, required: true },
  otp: { type: String, required: true },
  purpose: { type: String, enum: ['login', 'withdraw', 'transfer', 'admin-login'], required: true },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'used', 'expired'], default: 'pending' },
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
}, { timestamps: true });

OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default model('otps', OtpSchema);
