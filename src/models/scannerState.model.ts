import { Schema, model } from "mongoose";

/**
 * scanner_state — durable cursors for the chain scanners.
 *
 * The BEP-20 scanner keeps ONE global block cursor (`bep20:<tokenAddress>`), because
 * `eth_getLogs` is filtered by token + recipient-topic set, so a single range scan
 * covers every user's address at once.
 *
 * The cursor only advances after EVERY chunk in a range has succeeded. A partial
 * failure re-scans the same range next tick, which is harmless: deposit_credits'
 * unique index makes re-processing a no-op.
 */
const ScannerStateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    lastScannedBlock: { type: Number, default: 0 },
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    /** Observability: how far behind chain head we are. */
    headBlock: { type: Number, default: 0 },
    /** Doubles as an atomic sequence generator (key `hd-index:<network>`) for
     *  allocating HD derivation indices without a race. */
    counter: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

export default model("scanner_state", ScannerStateSchema, "scanner_state");