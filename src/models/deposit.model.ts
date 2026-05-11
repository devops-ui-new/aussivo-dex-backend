import { Schema, model, Types } from 'mongoose';

const DepositSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'users', required: true, index: true },
  vaultId: { type: Types.ObjectId, ref: 'vaults', required: true, index: true },
  amount: { type: Number, required: true },
  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  txHash: { type: String, default: '' },
  /** Ephemeral-flow idempotency + link to update txHash after treasury sweep. */
  pendingRequestId: { type: String, sparse: true, unique: true },
  walletAddress: { type: String, default: '' },
  /** Wallet(s) that sent on-chain funds for this deposit (audit). */
  depositorAddresses: { type: [String], default: [] },
  lockUntil: { type: Date, default: null },
  apyPercent: { type: Number, required: true },
  tierIndex: { type: Number, default: 0 },
  totalYieldPaid: { type: Number, default: 0 },
  yieldPaymentsCount: { type: Number, default: 0 },
  maxYieldPayments: { type: Number, required: true },  // = vault durationMonths
  status: { type: String, enum: ['active', 'withdrawn', 'matured'], default: 'active' },
  withdrawnAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

DepositSchema.index({ userId: 1, status: 1 });
DepositSchema.index({ vaultId: 1, status: 1 });
export default model('deposits', DepositSchema);
