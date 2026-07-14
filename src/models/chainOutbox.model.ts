import { Schema, model } from 'mongoose';

/**
 * ChainOutbox — durable queue for on-chain writes so they can never silently fail.
 *
 * Instead of fire-and-forget `void attest(...)` (which swallows RPC/gas errors and lets the
 * mirror drift from the DB), every on-chain write is recorded here as a job. A worker claims
 * pending jobs, sends the tx, and records the result — retrying with backoff on failure. If the
 * signer runs out of gas, jobs simply stay 'pending' and resume once it's funded; nothing is lost.
 *
 * De-dupe: `dedupeKey` (unique, sparse) collapses repeated attests for the same user into the
 * latest state. We upsert on it so a burst of deposits for one wallet becomes one pending job
 * carrying the newest principal, not a backlog of stale ones.
 */
const ChainOutboxSchema = new Schema(
  {
    // 'attest' (v2 per-user principal) | 'register' | 'deregister' | 'mint' | 'burn' | 'globalSync'
    kind: { type: String, required: true, index: true },

    // For attest: the user's wallet + snapshot to write.
    walletAddress: { type: String, default: '' },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    principalCents: { type: Number, default: 0 },   // principal * 100
    depositCount: { type: Number, default: 0 },

    // Free-form payload for non-attest kinds (mint/burn amount, memo, etc.).
    payload: { type: Schema.Types.Mixed, default: {} },

    // Collapses repeated writes for the same target to one pending job (e.g. `attest:0xabc...`).
    dedupeKey: { type: String, default: null },

    status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 8 },
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lastError: { type: String, default: '' },
    txHash: { type: String, default: '' },
    lockedAt: { type: Date, default: null }, // set when a worker claims it; cleared on release
  },
  { timestamps: true }
);

// One live (unfinished) job per dedupeKey. Finished jobs (done/failed) don't block new ones.
ChainOutboxSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' }, status: { $in: ['pending', 'processing'] } } }
);

export default model('ChainOutbox', ChainOutboxSchema, 'chain_outbox');