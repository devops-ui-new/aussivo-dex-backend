import { model, Schema, Types } from 'mongoose';

const UserSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  // Primary wallet — kept for display/backward compat. Not required; email is the login identity.
  walletAddress: { type: String, trim: true, lowercase: true, default: null, sparse: true, unique: true },
  // All wallets linked to this email. A single wallet may only appear on one user.
  walletAddresses: { type: [String], default: [] },
  referralCode: { type: String, required: true, unique: true, trim: true },
  referredBy: { type: Schema.Types.ObjectId, ref: 'users', default: null },
  registeredWith: { type: String, enum: ['wallet', 'email'], default: 'email' },

  // Balances
  usdtBalance: { type: Number, default: 0 },        // deposited USDT
  usdcBalance: { type: Number, default: 0 },        // deposited USDC
  yieldWalletUSDT: { type: Number, default: 0 },    // earned yield in USDT
  yieldWalletUSDC: { type: Number, default: 0 },    // earned yield in USDC
  referralEarnings: { type: Number, default: 0 },    // referral commissions
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },

  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
  kycStatus: { type: String, enum: ['none', 'pending', 'verified'], default: 'none' },
}, { timestamps: true });

UserSchema.index({ walletAddresses: 1 });

// Prevent negative balances
UserSchema.pre(['findOneAndUpdate', 'updateOne'], async function(next) {
  const update = this.getUpdate() as any;
  if (!update) return next();
  const fields = ['usdtBalance', 'usdcBalance', 'yieldWalletUSDT', 'yieldWalletUSDC', 'referralEarnings'];
  const doc = await this.model.findOne(this.getQuery());
  if (!doc) return next();
  for (const field of fields) {
    let newVal = doc[field];
    if (update.$inc?.[field] !== undefined) newVal = doc[field] + update.$inc[field];
    else if (update.$set?.[field] !== undefined) newVal = update.$set[field];
    else if (update[field] !== undefined) newVal = update[field];
    if (newVal < 0) return next(new Error(`${field} cannot go negative`));
  }
  next();
});

export default model('users', UserSchema);
