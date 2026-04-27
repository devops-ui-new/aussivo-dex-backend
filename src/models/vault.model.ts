import { Schema, model } from 'mongoose';

const TierSchema = new Schema({
  minAmount: { type: Number, required: true, min: 0 },
  maxAmount: { type: Number, required: true, min: 0 },
  apyPercent: { type: Number, required: true, min: 0 },  // monthly APY %
}, { _id: false });

const VaultSchema = new Schema({
  name: { type: String, required: true, trim: true, unique: true },
  description: { type: String, trim: true, default: '' },
  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  vaultType: { type: String, enum: ['flexible', 'locked'], default: 'locked' },
  lockDays: { type: Number, required: true, min: 0 },     // 0 = flexible
  durationMonths: { type: Number, required: true, min: 1 },// how many months APY is paid
  minDeposit: { type: Number, required: true, min: 0 },
  maxDeposit: { type: Number, required: true },
  capacity: { type: Number, required: true },              // total TVL cap
  totalStaked: { type: Number, default: 0 },
  totalUsers: { type: Number, default: 0 },
  earlyExitFeeBps: { type: Number, default: 0 },           // basis points e.g. 500 = 5%
  displayApy: { type: Number, default: null },             // admin-set annual APY shown on /pools and /pool/:id (overrides tier calc)
  displayApyMonthly: { type: Number, default: null },      // admin-set monthly APY shown in badges (overrides tier calc)
  popularityRank: { type: String, default: "" },           // e.g. "#1"
  investorsLabel: { type: String, default: "" },           // optional UI label override
  rebalanceFrequency: { type: String, default: "" },       // e.g. "Weekly"
  lastRebalanceDate: { type: String, default: "" },        // free-form display date
  nextRebalanceDate: { type: String, default: "" },        // free-form display date
  performanceFeePercent: { type: Number, default: 20 },    // display-only performance fee %
  reserveRatioLabel: { type: String, default: "20-30%" },  // display-only reserve ratio
  rewardCycleLabel: { type: String, default: "Real-time accrual" },
  smartContractLabel: { type: String, default: "Verified ✓" },
  circuitBreakerLabel: { type: String, default: "Active ✓" },
  tiers: { type: [TierSchema], required: true },
  strategies: [{
    name: { type: String, required: true },
    allocation: { type: Number, required: true },           // percentage
    protocol: { type: String, default: '' },
    color: { type: String, default: '' },                   // UI color hex
    apy: { type: String, default: '' },                     // display APY label e.g. "8.5%"
    status: { type: String, default: '' },                  // display status e.g. "Active"
  }],
  contractAddress: { type: String, default: '' },
  status: { type: String, enum: ['active', 'paused', 'completed'], default: 'active' },
}, { timestamps: true, versionKey: false });

export default model('vaults', VaultSchema);
