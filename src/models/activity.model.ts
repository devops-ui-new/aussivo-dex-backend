import { Schema, model, Types } from 'mongoose';

const ActivitySchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'users', default: null },
  adminId: { type: Types.ObjectId, ref: 'admins', default: null },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  type: { type: String, enum: ['deposit', 'withdraw', 'yield', 'referral', 'transfer', 'admin', 'system'], required: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

ActivitySchema.index({ userId: 1, createdAt: -1 });
export default model('activities', ActivitySchema);
