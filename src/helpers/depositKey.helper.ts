/**
 * depositKey.helper.ts — key material for persistent per-user deposit addresses.
 *
 * TWO MODES, both supported at once so nothing existing breaks:
 *
 *  1. HD (preferred, default when DEPOSIT_HD_MNEMONIC is set)
 *     Keys are DERIVED on demand from one master mnemonic + an integer index.
 *     The database stores ONLY the index — no key material at rest, ever.
 *     A database leak therefore yields nothing. A key can never be "purged"
 *     or lost, because it was never stored: it is re-derivable forever.
 *       EVM  : m/44'/60'/0'/0/{index}
 *       TRON : m/44'/195'/0'/0/{index}   (same secp256k1 curve, Tron coin type)
 *
 *  2. ENCRYPTED-AT-REST (fallback, and what every legacy row already uses)
 *     AES-256-GCM ciphertext in the document, exactly as the existing
 *     ephemeral flow does. Used when no mnemonic is configured, and always
 *     used to read legacy `pending_deposits.privateKeyEncrypted` rows.
 *
 * The critical behavioural change vs. the old ephemeral flow: key material is
 * NEVER purged. `keyPurgedAt` does not exist on a persistent deposit address.
 * Funds stranded on a deposit address are therefore ALWAYS recoverable.
 *
 * Backward compatibility: DEPOSIT_WALLET_SECRET falls back to the existing
 * EPHEMERAL_WALLET_SECRET, so legacy ciphertext keeps decrypting unchanged.
 */
import { ethers } from "ethers";
import { TronWeb } from "tronweb";
import {
  DEPOSIT_HD_MNEMONIC,
  DEPOSIT_HD_PASSPHRASE,
  DEPOSIT_WALLET_SECRET,
} from "../configs/constants";
import {
  encryptPrivateKeyHex,
  decryptPrivateKeyHex,
  hashPrivateKeyHexFingerprint,
} from "./walletCrypto.helper";

export type DepositNetwork = "bep20" | "trc20";

/** Key custody strategy recorded on each address document. */
export type KeySource = "hd" | "encrypted";

export const EVM_HD_BASE = "m/44'/60'/0'/0";
export const TRON_HD_BASE = "m/44'/195'/0'/0";

export function isHdEnabled(): boolean {
  return !!DEPOSIT_HD_MNEMONIC && DEPOSIT_HD_MNEMONIC.trim().split(/\s+/).length >= 12;
}

export function hdPathFor(network: DepositNetwork, index: number): string {
  const base = network === "trc20" ? TRON_HD_BASE : EVM_HD_BASE;
  return `${base}/${index}`;
}

/**
 * Derive the raw private key (0x-prefixed, 32 bytes) for a network+index.
 * Pure function of the mnemonic — deterministic and repeatable forever.
 */
function derivePrivateKey(network: DepositNetwork, index: number): string {
  if (!isHdEnabled()) throw new Error("HD deposit keys are not configured (DEPOSIT_HD_MNEMONIC)");
  const mnemonic = ethers.Mnemonic.fromPhrase(
    DEPOSIT_HD_MNEMONIC.trim(),
    DEPOSIT_HD_PASSPHRASE || undefined
  );
  const node = ethers.HDNodeWallet.fromMnemonic(mnemonic, hdPathFor(network, index));
  return node.privateKey; // 0x + 64 hex
}

/** Tron wants the private key WITHOUT the 0x prefix. */
export function stripHexPrefix(pk: string): string {
  const s = String(pk).trim();
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

export interface GeneratedDepositKey {
  address: string;              // checksummed EVM address, or Tron base58
  addressLookup: string;        // canonical form used for DB lookup/indexing
  keySource: KeySource;
  derivationIndex: number | null;
  derivationPath: string | null;
  privateKeyEncrypted: string;  // "" when keySource === 'hd' and backup is disabled
  privateKeyHash: string;       // SHA-256 fingerprint, audit only, always present
}

/**
 * Address lookup normalisation.
 * EVM addresses are case-insensitive → lowercase.
 * Tron base58 addresses ARE case-sensitive → preserved verbatim.
 */
export function normalizeDepositAddress(network: DepositNetwork, address: string): string {
  const raw = String(address || "").trim();
  if (network === "trc20") return raw;
  try {
    return ethers.getAddress(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function tronAddressFromPrivateKey(pkHexNo0x: string): string {
  // TronWeb exposes this statically; no network call is made.
  const addr = (TronWeb as any).address.fromPrivateKey(pkHexNo0x);
  if (!addr || typeof addr !== "string") throw new Error("Failed to derive Tron address");
  return addr;
}

/**
 * Create the key material for a new persistent deposit address.
 *
 * @param network       bep20 | trc20
 * @param index         HD index (ignored in encrypted mode)
 * @param storeBackup   also persist an AES-GCM ciphertext alongside the HD index.
 *                      Default true — belt and braces during migration. Set
 *                      DEPOSIT_KEY_BACKUP=false once you trust the mnemonic backup.
 */
export function createDepositKey(
  network: DepositNetwork,
  index: number,
  storeBackup: boolean
): GeneratedDepositKey {
  let privateKey: string;
  let keySource: KeySource;
  let derivationIndex: number | null;
  let derivationPath: string | null;

  if (isHdEnabled()) {
    privateKey = derivePrivateKey(network, index);
    keySource = "hd";
    derivationIndex = index;
    derivationPath = hdPathFor(network, index);
  } else {
    // No mnemonic configured — fall back to a random key stored encrypted,
    // i.e. exactly the custody model the current ephemeral flow already uses.
    privateKey = ethers.Wallet.createRandom().privateKey;
    keySource = "encrypted";
    derivationIndex = null;
    derivationPath = null;
  }

  const address =
    network === "trc20"
      ? tronAddressFromPrivateKey(stripHexPrefix(privateKey))
      : new ethers.Wallet(privateKey).address;

  // Encrypted copy: mandatory in encrypted mode, optional (default on) in HD mode.
  const needsCiphertext = keySource === "encrypted" || storeBackup;
  const privateKeyEncrypted = needsCiphertext
    ? encryptPrivateKeyHex(privateKey, DEPOSIT_WALLET_SECRET)
    : "";

  return {
    address,
    addressLookup: normalizeDepositAddress(network, address),
    keySource,
    derivationIndex,
    derivationPath,
    privateKeyEncrypted,
    privateKeyHash: hashPrivateKeyHexFingerprint(privateKey),
  };
}

/**
 * Recover the private key for an existing deposit address document.
 *
 * Resolution order:
 *   1. HD derivation (no stored secret needed)
 *   2. stored ciphertext (legacy rows, or HD rows with backup enabled)
 *
 * Throws only if BOTH are unavailable — which, by construction, cannot happen
 * for any address this module created.
 */
export function resolveDepositPrivateKey(doc: {
  network: DepositNetwork | string;
  keySource?: string;
  derivationIndex?: number | null;
  privateKeyEncrypted?: string;
  address?: string;
}): string {
  const network: DepositNetwork = doc.network === "trc20" ? "trc20" : "bep20";

  if (doc.keySource === "hd" && doc.derivationIndex != null && isHdEnabled()) {
    const pk = derivePrivateKey(network, Number(doc.derivationIndex));
    // Defence in depth: derived key MUST reproduce the stored address.
    const derivedAddr =
      network === "trc20"
        ? tronAddressFromPrivateKey(stripHexPrefix(pk))
        : new ethers.Wallet(pk).address;
    const a = normalizeDepositAddress(network, derivedAddr);
    const b = normalizeDepositAddress(network, doc.address || "");
    if (b && a !== b) {
      throw new Error(
        `HD derivation mismatch for ${doc.address} (index ${doc.derivationIndex}) — wrong DEPOSIT_HD_MNEMONIC?`
      );
    }
    return pk;
  }

  if (doc.privateKeyEncrypted) {
    return decryptPrivateKeyHex(doc.privateKeyEncrypted, DEPOSIT_WALLET_SECRET);
  }

  throw new Error(
    `No recoverable key for deposit address ${doc.address}: keySource=${doc.keySource}, hdEnabled=${isHdEnabled()}, hasCiphertext=false`
  );
}

/** Human-readable custody summary for the admin panel. */
export function describeKeyCustody(): {
  mode: KeySource;
  hdEnabled: boolean;
  backupCiphertext: boolean;
} {
  return {
    mode: isHdEnabled() ? "hd" : "encrypted",
    hdEnabled: isHdEnabled(),
    backupCiphertext: (process.env.DEPOSIT_KEY_BACKUP || "true") === "true",
  };
}