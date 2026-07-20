import { Request, Response } from "express";
import { Types } from "mongoose";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { randomInt } from "crypto";
import { createHash } from "crypto";
import { randomBytes } from "crypto";
import { ethers } from "ethers";
import UserModel from "../models/user.model";
import VaultModel from "../models/vault.model";
import DepositModel from "../models/deposit.model";
import YieldLogModel from "../models/yieldLog.model";
import OtpModel from "../models/otp.model";
import ActivityModel from "../models/activity.model";
import WithdrawRequestModel from "../models/withdrawRequest.model";
import PendingDepositModel from "../models/pendingDeposit.model";
import {
  JWT_SECRET,
  USDT_CONTRACT_ADDRESS,
  USDC_CONTRACT_ADDRESS,
  BSC_CHAIN_ID,
  BSC_PROVIDER_URL,
  EPHEMERAL_WALLET_SECRET,
  REFERRAL_L1_PERCENT,
  REFERRAL_L2_PERCENT,
  EARLY_EXIT_FEE_BPS,
  TRON_TREASURY_ADDRESS,
  TRON_USDT_CONTRACT,
  PERSISTENT_DEPOSIT_ADDRESSES,
  STEP_UP_WINDOW_MINUTES,
} from "../configs/constants";
import { encryptPrivateKeyHex, hashPrivateKeyHexFingerprint } from "../helpers/walletCrypto.helper";
import { settleUserYieldForAsset, settleDepositYield, computeLiveCycleYield } from "../helpers/apyDistribution.helper";
import { fundEphemeralGas } from "../services/ephemeralDepositSweep.service";
import { createTronEphemeral, fundTronEnergy } from "../services/tronDepositSweep.service";
import { enqueueAttest } from "../services/chainSync.worker";
import { getOrCreateDepositAddress, setActiveVault } from "../services/depositAddress.service";
import { IResponse } from "../utils/response.util";
import { sendEmail } from "../configs/email.config";
import logger from "../configs/logger.config";

const generateOtpCode = (): string => randomInt(100000, 1000000).toString();
const hashOtpCode = (otp: string): string => createHash("sha256").update(otp).digest("hex");
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const OTP_LOCKOUT_MINUTES = 15;

export default class UserController {
  req: Request;
  res: Response;
  userId?: string;

  constructor(req: Request, res: Response) {
    this.req = req;
    this.res = res;
    this.userId = req.body?.user?.id;
  }

  // ── AUTH ──
  async sendOTP(body: {
    email: string;
    walletAddress?: string;
    name?: string;
    referralCode?: string;
  }): Promise<IResponse> {
    try {
      const { email, walletAddress, name, referralCode } = body;
      if (!email)
        return {
          data: null,
          error: "Email required",
          message: "Email is required",
          status: 400,
        };

      const wallet = walletAddress ? walletAddress.toLowerCase() : null;

      // Email is the login identity; look up by email first.
      let user = await UserModel.findOne({ email: email.toLowerCase() });

      if (!user) {
        let referredBy = null;
        if (referralCode) {
          const referrer = await UserModel.findOne({ referralCode });
          if (referrer) referredBy = referrer._id;
        }

        const genCode = () =>
          "AUS" + Math.random().toString(36).substring(2, 8).toUpperCase();
        user = await UserModel.create({
          name: name || email.split("@")[0],
          email: email.toLowerCase(),
          walletAddress: wallet || null,
          walletAddresses: wallet ? [wallet] : [],
          referralCode: genCode(),
          referredBy,
          registeredWith: wallet ? "wallet" : "email",
        });

        await ActivityModel.create({
          userId: user._id,
          title: "Account Created",
          type: "system",
          description: `New user registered`,
        });
      } else if (wallet && !(user.walletAddresses || []).includes(wallet)) {
        // Known email, new wallet — append (uniqueness enforced by linkWallet-style check).
        const conflict = await UserModel.findOne({
          _id: { $ne: user._id },
          $or: [{ walletAddress: wallet }, { walletAddresses: wallet }],
        });
        if (!conflict) {
          user.walletAddresses = [...(user.walletAddresses || []), wallet];
          if (!user.walletAddress) user.walletAddress = wallet;
          await user.save();
        }
      }

      const otp = generateOtpCode();
      const otpHash = hashOtpCode(otp);
      await OtpModel.deleteMany({
        userId: user._id,
        purpose: "login",
        status: "pending",
      });
      await OtpModel.create({
        userId: user._id,
        email: user.email,
        otp: otpHash,
        purpose: "login",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
        failedAttempts: 0,
        lockedUntil: null,
      });

      logger.info(`[OTP] Generated login OTP for ${email}`);

      let sent = false;
      try {
        sent = await sendEmail(user.email, 'Your Verification Code — Aussivo.DEX', 'otp-verification', { otp, purpose: 'login' });
        if (sent) logger.info(`[OTP] Email sent to ${email}`);
      } catch (emailErr: any) {
        logger.error(`[OTP] Email send failed for ${email}: ${emailErr.message}`);
      }

      if (!sent) {
        await OtpModel.deleteMany({ userId: user._id, purpose: "login", status: "pending" });
        return {
          data: null,
          error: "email_delivery_failed",
          message:
            "Verification email could not be sent. If this persists, the server mail settings may be missing or invalid (e.g. Railway SMTP variables, Gmail App Password, FROM address matching the mailbox).",
          status: 503,
        };
      }

      return {
        data: { email: user.email, isNew: !body.walletAddress },
        error: null,
        message: "OTP sent to your email",
        status: 200,
      };
    } catch (err: any) {
      logger.error("sendOTP error:", err);
      return {
        data: null,
        error: err.message,
        message: "Failed to send OTP",
        status: 500,
      };
    }
  }

  /**
   * Auto-login for returning users — checks if wallet is registered,
   * if yes: auto-sends OTP to their email. User doesn't re-enter email.
   */
  async walletLogin(body: { walletAddress: string }): Promise<IResponse> {
    try {
      const { walletAddress } = body;
      if (!walletAddress)
        return {
          data: null,
          error: "Wallet required",
          message: "Wallet address required",
          status: 400,
        };

      let normalized: string;
      try {
        normalized = ethers.getAddress(walletAddress.trim()).toLowerCase();
      } catch {
        return {
          data: null,
          error: "Invalid wallet",
          message: "Valid wallet address required",
          status: 400,
        };
      }

      const user = await UserModel.findOne({
        status: "active",
        $or: [{ walletAddress: normalized }, { walletAddresses: normalized }],
      });
      if (!user) {
        return {
          data: { registered: false },
          error: null,
          message: "Wallet not registered",
          status: 200,
        };
      }

      const otp = generateOtpCode();
      const otpHash = hashOtpCode(otp);
      await OtpModel.deleteMany({
        userId: user._id,
        purpose: "login",
        status: "pending",
      });
      await OtpModel.create({
        userId: user._id,
        email: user.email,
        otp: otpHash,
        purpose: "login",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        failedAttempts: 0,
        lockedUntil: null,
      });

      logger.info(`[OTP] Generated wallet-login OTP for ${user.email}`);
      let sent = false;
      try {
        sent = await sendEmail(user.email, 'Your Verification Code — Aussivo.DEX', 'otp-verification', { otp, purpose: 'login' });
      } catch (e: any) {
        logger.error(`[OTP] Email failed: ${e.message}`);
      }

      if (!sent) {
        await OtpModel.deleteMany({ userId: user._id, purpose: "login", status: "pending" });
        return {
          data: { registered: true, email: user.email },
          error: "email_delivery_failed",
          message:
            "Verification email could not be sent. Check server SMTP configuration (Railway env: SMTP_HOST, SMTP_USER, SMTP_PASS; Gmail needs an App Password; FROM should match the sending account).",
          status: 503,
        };
      }

      // Mask email for display: abc@gmail.com → a**@gmail.com
      const [local, domain] = user.email.split("@");
      const masked = local[0] + "***" + "@" + domain;

      return {
        data: {
          registered: true,
          email: user.email,
          maskedEmail: masked,
          name: user.name,
        },
        error: null,
        message: "OTP sent to your registered email",
        status: 200,
      };
    } catch (err: any) {
      logger.error("walletLogin error:", err);
      return { data: null, error: err.message, message: "Failed", status: 500 };
    }
  }

  async verifyOTP(body: { email: string; otp: string }): Promise<IResponse> {
    try {
      const { email, otp } = body;
      if (!email || !otp)
        return {
          data: null,
          error: "Missing fields",
          message: "Email and OTP required",
          status: 400,
        };

      const otpRecord = await OtpModel.findOne({
        email: email.toLowerCase(),
        purpose: "login",
        status: "pending",
        expiresAt: { $gt: new Date() },
      }).sort({ createdAt: -1 });

      if (!otpRecord)
        return {
          data: null,
          error: "Invalid OTP",
          message: "Invalid or expired OTP",
          status: 400,
        };

      if (otpRecord.lockedUntil && new Date(otpRecord.lockedUntil) > new Date()) {
        const waitSec = Math.max(1, Math.ceil((new Date(otpRecord.lockedUntil).getTime() - Date.now()) / 1000));
        return {
          data: null,
          error: "Too many attempts",
          message: `Too many invalid attempts. Try again in ${waitSec}s`,
          status: 429,
        };
      }

      const incomingOtpHash = hashOtpCode(otp);
      if (incomingOtpHash !== otpRecord.otp) {
        const failedAttempts = Number((otpRecord as any).failedAttempts || 0) + 1;
        const shouldLock = failedAttempts >= OTP_MAX_VERIFY_ATTEMPTS;
        const lockUntil = shouldLock ? new Date(Date.now() + OTP_LOCKOUT_MINUTES * 60 * 1000) : null;
        await OtpModel.findByIdAndUpdate(otpRecord._id, {
          failedAttempts,
          lockedUntil: lockUntil,
        });
        if (shouldLock) {
          return {
            data: null,
            error: "Too many attempts",
            message: `Too many invalid attempts. Locked for ${OTP_LOCKOUT_MINUTES} minutes`,
            status: 429,
          };
        }
        return {
          data: null,
          error: "Invalid OTP",
          message: `Invalid OTP. ${OTP_MAX_VERIFY_ATTEMPTS - failedAttempts} attempt(s) left`,
          status: 400,
        };
      }

      await OtpModel.findByIdAndUpdate(otpRecord._id, { status: "used", failedAttempts: 0, lockedUntil: null });

      const user = await UserModel.findById(otpRecord.userId);
      if (!user)
        return {
          data: null,
          error: "User not found",
          message: "User not found",
          status: 404,
        };

      // Email OTP proves control of the account, so this is a FULL session:
      // it may withdraw and link wallets.
      // `verifiedAt` is what bounds the step-up window. The session itself still lasts
      // 7 days — only the authority to withdraw expires.
      const token = jwt.sign(
        { id: user._id, email: user.email, role: "user", authLevel: "otp", verifiedAt: Math.floor(Date.now() / 1000) },
        JWT_SECRET,
        { expiresIn: "7d" },
      );

      return {
        data: {
          token,
          authLevel: "otp",
          verifiedFor: STEP_UP_WINDOW_MINUTES,
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            walletAddress: user.walletAddress,
            walletAddresses: user.walletAddresses || [],
            referralCode: user.referralCode,
          },
        },
        error: null,
        message: "Login successful",
        status: 200,
      };
    } catch (err: any) {
      return {
        data: null,
        error: err.message,
        message: "Verification failed",
        status: 500,
      };
    }
  }

  // ── USER DETAILS ──
  async getUserDetails(): Promise<IResponse> {
    try {
      const user = await UserModel.findById(this.userId).select("-__v");
      if (!user)
        return {
          data: null,
          error: "Not found",
          message: "User not found",
          status: 404,
        };

      const activeDeposits = await DepositModel.countDocuments({
        userId: this.userId,
        status: "active",
      });
      const totalYield = await YieldLogModel.aggregate([
        { $match: { userId: user._id, source: "vault_apy" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      const totalReferralEarnings = await YieldLogModel.aggregate([
        {
          $match: {
            userId: user._id,
            source: { $in: ["referral_l1", "referral_l2"] },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      const directReferrals = await UserModel.countDocuments({
        referredBy: user._id,
      });

      return {
        data: {
          ...user.toObject(),
          stats: {
            activeDeposits,
            totalYieldEarned: totalYield[0]?.total || 0,
            totalReferralEarnings: totalReferralEarnings[0]?.total || 0,
            directReferrals,
          },
          // True when the user has money invested but no wallet on file — the frontend uses this
          // to prompt (once) for a wallet so their position can be attested on-chain.
          needsWalletForAttestation: activeDeposits > 0 && !(user.walletAddress || "").trim(),
        },
        error: null,
        message: "User details retrieved",
        status: 200,
      };
    } catch (err: any) {
      return {
        data: null,
        error: err.message,
        message: "Error fetching user",
        status: 500,
      };
    }
  }

  // ── VAULTS ──
  async getVaults(): Promise<IResponse> {
    try {
      const vaults = await VaultModel.find({ status: "active" }).sort({
        createdAt: -1,
      });
      return {
        data: vaults,
        error: null,
        message: "Vaults retrieved",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  async getVaultById(vaultId: string): Promise<IResponse> {
    try {
      const vault = await VaultModel.findById(vaultId);
      if (!vault)
        return {
          data: null,
          error: "Not found",
          message: "Vault not found",
          status: 404,
        };
      const depositorCount = await DepositModel.countDocuments({
        vaultId,
        status: "active",
      });
      return {
        data: { ...vault.toObject(), depositorCount },
        error: null,
        message: "Vault details",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  // ── DEPOSIT (persistent per-user address) ──────────────────────────────────
  // Returns the user's ONE permanent deposit address for the chosen chain. The
  // address never expires and its key is never purged, so funds sent at any time
  // — including long after the UI closed — are always detected and recoverable.
  //
  // The response shape is intentionally identical to the legacy one so the
  // frontend needs no change. `expiresAt` is omitted, which DepositQR.jsx already
  // treats as "no countdown".
  async getDepositQR(body: {
    vaultId: string;
    amount?: number;
    network?: "bep20" | "trc20";
  }): Promise<IResponse> {
    // Feature flag OFF → original code path, untouched.
    if (!PERSISTENT_DEPOSIT_ADDRESSES) {
      return this.getDepositQRLegacy(body);
    }

    try {
      const { vaultId } = body;
      const network: "bep20" | "trc20" = body.network === "trc20" ? "trc20" : "bep20";

      const vault = await VaultModel.findById(vaultId);
      if (!vault || vault.status !== "active") {
        return {
          data: null,
          error: "Vault not available",
          message: "Vault not found or inactive",
          status: 404,
        };
      }

      if (network === "trc20") {
        if (vault.asset !== "USDT") {
          return { data: null, error: "Unsupported", message: "TRC20 supports USDT only", status: 400 };
        }
        if (!TRON_TREASURY_ADDRESS) {
          return { data: null, error: "Server misconfigured", message: "TRC20 deposits are not enabled yet", status: 503 };
        }
      }

      // The permanent address. Created once, reused forever.
      const addrDoc = await getOrCreateDepositAddress(this.userId as string, network);
      await setActiveVault(addrDoc._id, vault._id);

      // A lightweight session row, purely so the existing status-polling endpoint
      // and the modal auto-close keep working. It holds NO key material and no
      // expiry semantics that could lose money.
      const requestId =
        network === "trc20"
          ? `tron_${randomBytes(24).toString("hex")}`
          : `0x${randomBytes(32).toString("hex")}`;

      await PendingDepositModel.updateMany(
        { userId: this.userId, network, depositAddressId: addrDoc._id, status: "pending" },
        { $set: { status: "expired" } }
      );

      const pendingDoc = await PendingDepositModel.create({
        userId: this.userId,
        vaultId,
        expectedAmount: 0,
        expectedAmountBaseUnits: "0",
        requestId,
        asset: vault.asset,
        network,
        walletAddress: network === "bep20" ? addrDoc.addressLookup : "",
        ephemeralAddress: addrDoc.address, // reused field name; now a permanent address
        depositAddressId: addrDoc._id,     // marks this row as NOT legacy
        openAmount: true,
        privateKeyEncrypted: "",           // key lives in deposit_addresses, never here
        privateKeyHash: addrDoc.privateKeyHash,
        // Schema requires expiresAt. The SESSION expires; the ADDRESS never does.
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });

      const qrCode = await QRCode.toDataURL(addrDoc.address, {
        width: 300,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      const common = {
        qrCode,
        qrPayload: addrDoc.address,
        qrPayloadAddressOnly: addrDoc.address,
        depositAddress: addrDoc.address,
        openAmount: true,
        amount: null,
        amountInBaseUnits: "0",
        requestId,
        asset: vault.asset,
        vaultName: vault.name,
        pendingDepositId: String(pendingDoc._id),
        persistent: true,
        neverExpires: true,
        // expiresAt / expiresInSeconds intentionally omitted → no countdown rendered.
      };

      if (network === "trc20") {
        return {
          data: {
            ...common,
            tokenAddress: TRON_USDT_CONTRACT,
            network: "Tron (TRC-20)",
            networkKey: "trc20",
          },
          error: null,
          message: "Deposit address ready",
          status: 200,
        };
      }

      const TOKEN_ADDRESSES: Record<string, string> = {
        USDT: USDT_CONTRACT_ADDRESS,
        USDC: USDC_CONTRACT_ADDRESS,
      };

      return {
        data: {
          ...common,
          tokenAddress: TOKEN_ADDRESSES[vault.asset],
          qrEip681: addrDoc.address,
          network:
            BSC_CHAIN_ID === 56
              ? "BNB Smart Chain (BEP-20)"
              : "BSC Testnet (BEP-20, chainId 97)",
          networkKey: "bep20",
          chainId: BSC_CHAIN_ID,
          chainIdHex: `0x${BSC_CHAIN_ID.toString(16)}`,
        },
        error: null,
        message: "Deposit address ready",
        status: 200,
      };
    } catch (err: any) {
      logger.error(`[getDepositQR] ${err?.message || err}`);
      return {
        data: null,
        error: err.message,
        message: "Error generating deposit address",
        status: 500,
      };
    }
  }

  // ── DEPOSIT (ephemeral address + QR; server sweeps to treasury after payment) ──
  // `amount` is OPTIONAL. When omitted/0 the address is "open-amount": the user simply
  // scans and sends any amount from their wallet, and the sweep service captures and
  // credits whatever arrives, fast (no upfront amount, no exact-match required).
  async getDepositQRLegacy(body: {
    vaultId: string;
    amount?: number;
    network?: "bep20" | "trc20";
  }): Promise<IResponse> {
    try {
      const { vaultId } = body;
      const network = body.network === "trc20" ? "trc20" : "bep20";
      const rawAmount = Number(body.amount);
      const hasAmount = Number.isFinite(rawAmount) && rawAmount > 0;
      const amount = hasAmount ? rawAmount : 0;
      const openAmount = !hasAmount;

      const vault = await VaultModel.findById(vaultId);
      if (!vault || vault.status !== "active")
        return {
          data: null,
          error: "Vault not available",
          message: "Vault not found or inactive",
          status: 404,
        };

      // Bounds only apply when the user pre-specified an amount. Open-amount deposits
      // capture whatever the user sends and credit it on detection.
      if (hasAmount) {
        if (amount < vault.minDeposit)
          return { data: null, error: "Below minimum", message: `Minimum deposit is $${vault.minDeposit}`, status: 400 };
        if (amount > vault.maxDeposit)
          return { data: null, error: "Above maximum", message: `Maximum deposit is $${vault.maxDeposit}`, status: 400 };
        if (vault.totalStaked + amount > vault.capacity)
          return { data: null, error: "Vault full", message: "Vault capacity reached", status: 400 };
      }

      if (!EPHEMERAL_WALLET_SECRET || EPHEMERAL_WALLET_SECRET.length < 8) {
        return {
          data: null,
          error: "Server misconfigured",
          message: "Set EPHEMERAL_WALLET_SECRET (8+ chars) for deposit wallets",
          status: 500,
        };
      }

      // ─── TRC20 (Tron) branch ───────────────────────────────────────────────
      // Tron uses base58 addresses + 6-decimal USDT + energy/TRX gas. The Tron sweep
      // service detects the deposit, credits via the same accounting, and sweeps to
      // TRON_TREASURY_ADDRESS. USDC is not offered on Tron here.
      if (network === "trc20") {
        if (vault.asset !== "USDT") {
          return { data: null, error: "Unsupported", message: "TRC20 supports USDT only", status: 400 };
        }
        if (!TRON_TREASURY_ADDRESS) {
          return { data: null, error: "Server misconfigured", message: "TRC20 deposits are not enabled yet", status: 503 };
        }
        const requestIdTron = `tron_${randomBytes(24).toString("hex")}`;
        const { address: tronAddress, privateKey: tronPk } = await createTronEphemeral();
        const encTron = encryptPrivateKeyHex(tronPk, EPHEMERAL_WALLET_SECRET);
        const hashTron = hashPrivateKeyHexFingerprint(tronPk);

        const INTENT_TTL_MS_TRON = openAmount ? 60 * 60 * 1000 : 15 * 60 * 1000;
        const expiresAtTron = new Date(Date.now() + INTENT_TTL_MS_TRON);

        const pendingTron = await PendingDepositModel.create({
          userId: this.userId,
          vaultId,
          expectedAmount: amount,
          expectedAmountBaseUnits: hasAmount ? Math.round(amount * 1e6).toString() : "0", // 6-dec on Tron
          requestId: requestIdTron,
          asset: vault.asset,
          network: "trc20",
          walletAddress: "",
          ephemeralAddress: tronAddress, // base58, case-preserved
          openAmount,
          privateKeyEncrypted: encTron,
          privateKeyHash: hashTron,
          expiresAt: expiresAtTron,
        });

        // Best-effort energy pre-fund. Energy is ALSO funded lazily at sweep time, so this must
        // never block the response or throw — a TronGrid 429 here must not affect the deposit
        // record in any way. Fire-and-forget (previously this ran inline and a 429 cascaded).
        void fundTronEnergy(tronAddress)
          .then((tx) => (tx ? PendingDepositModel.findByIdAndUpdate(pendingTron._id, { gasFundTxHash: tx }) : null))
          .catch(() => { /* ignore — sweep will fund energy when needed */ });

        const qrTron = await QRCode.toDataURL(tronAddress, { width: 300, margin: 2, color: { dark: "#000000", light: "#ffffff" } });

        return {
          data: {
            qrCode: qrTron,
            qrPayload: tronAddress,
            qrPayloadAddressOnly: tronAddress,
            depositAddress: tronAddress,
            tokenAddress: TRON_USDT_CONTRACT,
            openAmount,
            amount: hasAmount ? amount : null,
            requestId: requestIdTron,
            asset: vault.asset,
            network: "Tron (TRC-20)",
            networkKey: "trc20",
            vaultName: vault.name,
            expiresAt: expiresAtTron.toISOString(),
            expiresInSeconds: Math.floor(INTENT_TTL_MS_TRON / 1000),
            gasFundTxHash: undefined, // energy pre-fund is async/best-effort now; not awaited here
            pendingDepositId: String(pendingTron._id),
          },
          error: null,
          message: "Deposit address generated",
          status: 200,
        };
      }

      const TOKEN_ADDRESSES: Record<string, string> = {
        USDT: USDT_CONTRACT_ADDRESS,
        USDC: USDC_CONTRACT_ADDRESS,
      };
      const tokenAddress = TOKEN_ADDRESSES[vault.asset];
      const decimals = 18;
      const amountInBaseUnits = hasAmount
        ? (BigInt(Math.round(amount * 10 ** 6)) * BigInt(10 ** (decimals - 6))).toString()
        : "0";
      const requestId = `0x${randomBytes(32).toString("hex")}`;

      const ephemeral = ethers.Wallet.createRandom();
      const ephemeralAddress = ephemeral.address.toLowerCase();
      const privateKeyEncrypted = encryptPrivateKeyHex(ephemeral.privateKey, EPHEMERAL_WALLET_SECRET);
      const privateKeyHash = hashPrivateKeyHexFingerprint(ephemeral.privateKey);

      // Open-amount addresses stay valid longer (user picks the amount in their wallet);
      // they are credited on first detection regardless of this window.
      const INTENT_TTL_MS = openAmount ? 60 * 60 * 1000 : 15 * 60 * 1000;
      const expiresAt = new Date(Date.now() + INTENT_TTL_MS);

      const pendingDoc = await PendingDepositModel.create({
        userId: this.userId,
        vaultId,
        expectedAmount: amount,
        expectedAmountBaseUnits: amountInBaseUnits,
        requestId,
        asset: vault.asset,
        walletAddress: ephemeralAddress,
        ephemeralAddress,
        openAmount,
        privateKeyEncrypted,
        privateKeyHash,
        expiresAt,
      });

      const gasFundTxHash = await fundEphemeralGas(ephemeralAddress);
      if (gasFundTxHash) {
        await PendingDepositModel.findByIdAndUpdate(pendingDoc._id, { gasFundTxHash });
      }

      const recipientChecksummed = ethers.getAddress(ephemeral.address);
      const qrPayload = recipientChecksummed;
      const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
        width: 300,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      return {
        data: {
          qrCode: qrCodeDataUrl,
          qrPayload,
          qrPayloadAddressOnly: ephemeral.address,
          qrEip681: qrPayload,
          depositAddress: ephemeral.address,
          tokenAddress,
          openAmount,
          amount: hasAmount ? amount : null,
          amountInBaseUnits,
          requestId,
          asset: vault.asset,
          network: BSC_CHAIN_ID === 56 ? "BNB Smart Chain (BEP-20)" : "BSC Testnet (BEP-20, chainId 97)",
          networkKey: "bep20",
          chainId: BSC_CHAIN_ID,
          chainIdHex: `0x${BSC_CHAIN_ID.toString(16)}`,
          vaultName: vault.name,
          expiresAt: expiresAt.toISOString(),
          expiresInSeconds: Math.floor(INTENT_TTL_MS / 1000),
          gasFundTxHash: gasFundTxHash || undefined,
          pendingDepositId: String(pendingDoc._id),
        },
        error: null,
        message: "Deposit address generated",
        status: 200,
      };
    } catch (err: any) {
      return {
        data: null,
        error: err.message,
        message: "Error generating QR",
        status: 500,
      };
    }
  }

  /** Poll while deposit modal is open — tells UI when USDT arrived (credited / matched). */
  async getDepositPendingStatus(pendingId: string): Promise<IResponse> {
    try {
      if (!pendingId || !Types.ObjectId.isValid(pendingId)) {
        return { data: null, error: "Invalid id", message: "Invalid pending deposit id", status: 400 };
      }
      const doc = await PendingDepositModel.findOne({ _id: pendingId, userId: this.userId }).lean();
      if (!doc) {
        return { data: null, error: "Not found", message: "Pending deposit not found", status: 404 };
      }
      const paymentReceived = doc.status === "credited" || doc.status === "matched";
      const fullySettled = doc.status === "matched";
      return {
        data: {
          status: doc.status,
          paymentReceived,
          fullySettled,
          expiresAt: doc.expiresAt,
          userCreditedAt: doc.userCreditedAt || null,
          sweepTxHash: doc.sweepTxHash || "",
        },
        error: null,
        message: "OK",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  /**
   * User closed the deposit modal. Keep tracking this one-time address until expiry;
   * UI close should not stop backend monitoring.
   */
  async cancelPendingDeposit(body: { pendingDepositId?: string }): Promise<IResponse> {
    try {
      const pendingDepositId = (body?.pendingDepositId || "").trim();
      if (!pendingDepositId || !Types.ObjectId.isValid(pendingDepositId)) {
        return { data: null, error: "Invalid id", message: "Invalid pending deposit id", status: 400 };
      }
      const doc = await PendingDepositModel.findOne({ _id: pendingDepositId, userId: this.userId }).lean();
      if (!doc) {
        return { data: null, error: "Not found", message: "Pending deposit not found", status: 404 };
      }
      if (doc.status !== "pending") {
        return {
          data: null,
          error: "Not cancellable",
          message:
            doc.status === "credited"
              ? "Payment already received — this session cannot be cancelled."
              : "This deposit is no longer active.",
          status: 400,
        };
      }
      if (doc.userCreditedAt) {
        return {
          data: null,
          error: "Not cancellable",
          message: "Payment already received — cannot cancel.",
          status: 400,
        };
      }

      await PendingDepositModel.findByIdAndUpdate(doc._id, {
        $set: { userDismissedAt: new Date() },
      });
      logger.info(`[Deposit] User ${this.userId} dismissed pending ${pendingDepositId}; tracking continues until expiry.`);
      return {
        data: { cancelled: true, trackingContinues: true, expiresAt: doc.expiresAt },
        error: null,
        message: "Deposit window closed in UI. We will keep tracking this address until it expires.",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Cancel failed", status: 500 };
    }
  }

  // ── recordDeposit REMOVED ──
  // It credited an arbitrary `amount` from the request body with no on-chain
  // verification, no duplicate check and no bounds check, so any authenticated user
  // could mint themselves a balance. Deposits are now only ever created from an
  // observed on-chain transfer (depositAddress.service / the chain scanners).

  // ── USER DEPOSITS ──
  async getDeposits(page = 1, limit = 10): Promise<IResponse> {
    try {
      // Mature any completed 30-day cycles for this user before returning, so the withdrawable
      // yield wallet is always current and the live "accruing this cycle" figure resets on time.
      try {
        const active = await DepositModel.find({ userId: this.userId, status: "active" });
        for (const d of active) { try { await settleDepositYield(d); } catch { /* non-blocking */ } }
      } catch { /* non-blocking */ }

      const skip = (page - 1) * limit;
      const [deposits, total, pendingRedemptions] = await Promise.all([
        DepositModel.find({ userId: this.userId })
          .populate("vaultId", "name asset displayApy displayApyMonthly tiers")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        DepositModel.countDocuments({ userId: this.userId }),
        WithdrawRequestModel.find({ userId: this.userId, source: "deposit", status: "pending" }).select("depositId"),
      ]);
      const pendingSet = new Set(pendingRedemptions.map((r: any) => String(r.depositId)));
      const withFlag = deposits.map((d: any) => {
        const obj = d.toObject();
        const v = obj.vaultId || {};
        // Tier apyPercent and displayApy are ANNUAL %. Monthly = annual / 12.
        const tierAnnual = v.tiers?.[0]?.apyPercent || 0;
        const poolApy =
          v.displayApy != null ? Number(v.displayApy) : tierAnnual;
        const poolApyMonthly =
          v.displayApyMonthly != null
            ? Number(v.displayApyMonthly)
            : poolApy / 12;
        return {
          ...obj,
          redemptionPending: pendingSet.has(String(obj._id)),
          poolApy: Number(poolApy.toFixed(2)),
          poolApyMonthly: Number(poolApyMonthly.toFixed(2)),
        };
      });
      return {
        data: { deposits: withFlag, total, page, limit, pages: Math.ceil(total / limit) },
        error: null,
        message: "Deposits retrieved",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  // ── YIELD HISTORY ──
  async getYieldLogs(
    page = 1,
    limit = 20,
    source?: string,
  ): Promise<IResponse> {
    try {
      const skip = (page - 1) * limit;
      const query: any = { userId: this.userId };
      if (source) query.source = source;
      const [logs, total] = await Promise.all([
        YieldLogModel.find(query)
          .populate("vaultId", "name")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        YieldLogModel.countDocuments(query),
      ]);
      return {
        data: { logs, total, page, limit },
        error: null,
        message: "Yield logs retrieved",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  // ── MY WITHDRAWALS (history with status) ──
  async getMyWithdrawals(page = 1, limit = 20): Promise<IResponse> {
    try {
      const skip = (page - 1) * limit;
      const query: any = { userId: this.userId };
      const [requests, total] = await Promise.all([
        WithdrawRequestModel.find(query)
          .populate("depositId", "amount asset")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        WithdrawRequestModel.countDocuments(query),
      ]);
      return {
        data: { requests, total, page, limit },
        error: null,
        message: "Withdrawals retrieved",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  // ── REFERRAL DATA ──
  async getReferralData(): Promise<IResponse> {
    try {
      const user = await UserModel.findById(this.userId);
      if (!user)
        return {
          data: null,
          error: "Not found",
          message: "User not found",
          status: 404,
        };

      const l1Referrals = await UserModel.find({ referredBy: user._id }).select(
        "name email createdAt totalDeposited",
      );
      const l1Ids = l1Referrals.map((r) => r._id);
      const l2Referrals = await UserModel.find({
        referredBy: { $in: l1Ids },
      }).select("name email createdAt totalDeposited");

      const recentCommissions = await YieldLogModel.find({
        userId: user._id,
        source: { $in: ["referral_l1", "referral_l2"] },
      })
        .sort({ createdAt: -1 })
        .limit(20);

      return {
        data: {
          referralCode: user.referralCode,
          referralLink: `https://dex.aussivo.com?ref=${user.referralCode}`,
          l1: {
            count: l1Referrals.length,
            users: l1Referrals,
            commissionRate: `${REFERRAL_L1_PERCENT}%`,
          },
          l2: {
            count: l2Referrals.length,
            users: l2Referrals,
            commissionRate: `${REFERRAL_L2_PERCENT}%`,
          },
          totalEarnings: user.referralEarnings,
          recentCommissions,
        },
        error: null,
        message: "Referral data retrieved",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  // ── WITHDRAW REQUEST ──
  async requestWithdraw(body: {
    amount: number;
    asset: string;
    source: string;
    walletAddress: string;
    depositId?: string;
  }): Promise<IResponse> {
    try {
      const { amount, asset, source, depositId } = body;
      const user = await UserModel.findById(this.userId);
      if (!user)
        return { data: null, error: "Not found", message: "User not found", status: 404 };

      // ── PAYOUT ADDRESS MUST BELONG TO THIS USER ──
      // Previously this came straight from the request body and was never checked, so a
      // caller could direct someone else's funds to their own wallet. The destination is
      // now constrained to wallets already linked to the authenticated account, and must
      // be a well-formed address.
      let walletAddress: string;
      {
        const raw = String((body as any).walletAddress || "").trim();
        if (!raw)
          return { data: null, error: "Missing wallet", message: "A payout wallet address is required", status: 400 };

        let normalized: string;
        try {
          normalized = ethers.getAddress(raw).toLowerCase();
        } catch {
          return { data: null, error: "Invalid wallet", message: "Payout address is not a valid wallet address", status: 400 };
        }

        const linked = new Set<string>(
          [
            ...(user.walletAddresses || []).map((w: string) => (w || "").trim().toLowerCase()),
            (user.walletAddress || "").trim().toLowerCase(),
          ].filter(Boolean)
        );

        if (!linked.has(normalized)) {
          logger.warn(
            `[WITHDRAW] Rejected payout to unlinked address. user=${user.email} requested=${normalized}`
          );
          return {
            data: null,
            error: "Unlinked wallet",
            message: "Withdrawals can only be sent to a wallet linked to your account. Link it first, then try again.",
            status: 403,
          };
        }
        walletAddress = ethers.getAddress(normalized); // checksummed for the payout tx
      }

      const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
      const FEE_RATE = EARLY_EXIT_FEE_BPS / 10000; // 100 bps → 0.01
      const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
      // Fee applies only before the 30-day mark (measured from `refDate`); free after.
      const feeFor = (gross: number, refDate: any) => {
        const early = Date.now() < new Date(refDate).getTime() + CYCLE_MS;
        const fee = early ? round6(gross * FEE_RATE) : 0;
        return { early, fee, netAmount: round6(gross - fee) };
      };
      // For balances not tied to one deposit (aggregate yield, referral), the 30-day clock
      // starts at the user's earliest deposit (fallback: account creation).
      const accountRefDate = async () => {
        const earliest = await DepositModel.findOne({ userId: user._id }).sort({ createdAt: 1 }).select("createdAt");
        return (earliest?.createdAt as any) || (user as any).createdAt || new Date();
      };

      // ── DEPOSIT (principal) redemption — withdrawable ANYTIME ──
      // Before 30 days: 1% early-exit fee AND the current (un-matured) cycle's yield is
      // forfeited (it never matured, so it's simply never credited). Matured yield from
      // completed cycles already sits in the user's yield wallet and is kept.
      if (source === "deposit") {
        if (!depositId)
          return { data: null, error: "Missing depositId", message: "depositId is required for deposit redemption", status: 400 };

        const deposit = await DepositModel.findById(depositId);
        if (!deposit || String(deposit.userId) !== String(user._id))
          return { data: null, error: "Not found", message: "Deposit not found", status: 404 };
        if (deposit.status !== "active" && deposit.status !== "matured")
          return { data: null, error: "Invalid state", message: "Deposit is not redeemable", status: 400 };

        const existing = await WithdrawRequestModel.findOne({ depositId: deposit._id, status: "pending" });
        if (existing)
          return { data: null, error: "Duplicate", message: "Redemption already requested for this deposit", status: 400 };

        // Credit any completed-but-not-yet-matured cycle first, so the user keeps every FULL
        // cycle they've earned. The current partial cycle stays un-matured and is forfeited.
        try { await settleDepositYield(deposit); } catch { /* non-blocking */ }
        const forfeitedLiveYield = round6(computeLiveCycleYield(deposit));

        const { early, fee, netAmount } = feeFor(deposit.amount, deposit.createdAt);
        const request = await WithdrawRequestModel.create({
          userId: user._id,
          amount: deposit.amount,
          fee, netAmount, early,
          asset: deposit.asset,
          walletAddress,
          source: "deposit",
          depositId: deposit._id,
        });

        return {
          data: { ...request.toObject(), forfeitedLiveYield }, error: null,
          message: early
            ? `Redemption submitted — 1% early-exit fee applies and this cycle's un-matured yield (~$${forfeitedLiveYield.toFixed(4)}) is forfeited. You receive ${netAmount} ${deposit.asset}.`
            : "Redemption request submitted",
          status: 201,
        };
      }

      // ── YIELD — only MATURED yield is withdrawable (post 30-day cycles). No fee. ──
      // Live (un-matured) yield inside the current cycle is never withdrawable here; it only
      // becomes available once its 30-day cycle completes and matures into the yield wallet.
      if (source === "yield") {
        const asset2 = asset === "USDC" ? "USDC" : "USDT";

        const dupAgg = await WithdrawRequestModel.findOne({ userId: user._id, source: "yield", asset: asset2, status: "pending" });
        if (dupAgg)
          return { data: null, error: "Duplicate", message: "A yield withdrawal is already processing", status: 400 };

        // Mature any newly-completed cycles, then withdraw the whole matured balance.
        const bal = round6(await settleUserYieldForAsset(String(user._id), asset2));
        if (bal < 1e-6)
          return { data: null, error: "Nothing to withdraw", message: "No matured yield to withdraw yet — yield becomes withdrawable after each 30-day cycle completes.", status: 400 };

        const request = await WithdrawRequestModel.create({
          userId: user._id,
          amount: bal,
          fee: 0, netAmount: bal, early: false,
          asset: asset2,
          walletAddress,
          source: "yield",
        });
        return {
          data: request, error: null,
          message: "Matured yield withdrawal submitted",
          status: 201,
        };
      }

      if (source === "referral") {
        const dupRef = await WithdrawRequestModel.findOne({ userId: user._id, source: "referral", status: "pending" });
        if (dupRef)
          return { data: null, error: "Duplicate", message: "A referral withdrawal is already processing", status: 400 };
        const bal = Number((user as any).referralEarnings || 0);
        if (amount <= 0 || amount > bal)
          return { data: null, error: "Insufficient", message: "Insufficient balance", status: 400 };

        const { early, fee, netAmount } = feeFor(amount, await accountRefDate());
        const request = await WithdrawRequestModel.create({
          userId: user._id,
          amount,
          fee, netAmount, early,
          asset,
          walletAddress,
          source: "referral",
        });
        return {
          data: request, error: null,
          message: early ? `Referral withdrawal submitted — 1% early-exit fee applies (you receive ${netAmount} ${asset})` : "Withdrawal request submitted",
          status: 201,
        };
      }

      return { data: null, error: "Invalid source", message: "Invalid withdrawal source", status: 400 };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  /**
   * Direct wallet authentication for returning users.
   * If wallet is registered → issue JWT immediately (no OTP).
   * First-time users must go through email+OTP registration.
   */
  /**
   * Wallet auto-login — unchanged UX: connect a known wallet, get a session.
   *
   * SECURITY MODEL. A wallet address is public, so this cannot prove who the caller is.
   * The session it issues is therefore LIMITED (authLevel 'wallet'): it can browse the
   * portfolio, but it cannot move money or attach a new payout wallet. Those actions
   * require a session verified by email OTP (authLevel 'otp').
   *
   * That split is what keeps the convenience without the drain path: even if someone
   * reads a depositor address off a block explorer and gets a session, they cannot link
   * their own wallet and cannot withdraw.
   */
  async walletAuth(body: { walletAddress: string }): Promise<IResponse> {
    try {
      const { walletAddress } = body;
      if (!walletAddress)
        return { data: null, error: "Wallet required", message: "Wallet address required", status: 400 };

      let normalized: string;
      try {
        normalized = ethers.getAddress(String(walletAddress).trim()).toLowerCase();
      } catch {
        return { data: null, error: "Invalid wallet", message: "Valid wallet address required", status: 400 };
      }

      const user = await UserModel.findOne({
        status: "active",
        $or: [{ walletAddress: normalized }, { walletAddresses: normalized }],
      });
      if (!user) {
        return { data: { registered: false }, error: null, message: "Wallet not registered", status: 200 };
      }

      // Limited session. `authLevel` is what the withdraw/link-wallet guards check.
      const token = jwt.sign(
        { id: user._id, email: user.email, role: "user", authLevel: "wallet" },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      logger.info(`[AUTH] Wallet session (limited): ${user.email} (${normalized.slice(0, 10)}…)`);

      const [local, domain] = user.email.split("@");
      return {
        data: {
          registered: true,
          token,
          authLevel: "wallet",
          // Tells the frontend a withdrawal will need an email code, and where it goes.
          maskedEmail: local[0] + "***@" + domain,
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            walletAddress: user.walletAddress,
            walletAddresses: user.walletAddresses || [],
            referralCode: user.referralCode,
          },
        },
        error: null,
        message: "Welcome back!",
        status: 200,
      };
    } catch (err: any) {
      logger.error("walletAuth error:", err);
      return { data: null, error: err.message, message: "Authentication failed", status: 500 };
    }
  }

  // ── LINK WALLET ADDRESS ──
  // Adds a wallet to the user's walletAddresses list. If the user has no primary
  // wallet yet, the new address becomes primary. A single wallet cannot be linked
  // to two emails.
  async linkWallet(body: { walletAddress: string }): Promise<IResponse> {
    try {
      const { walletAddress } = body;
      if (!walletAddress || typeof walletAddress !== "string")
        return { data: null, error: "Invalid wallet", message: "Valid wallet address required", status: 400 };

      let normalized: string;
      try {
        normalized = ethers.getAddress(walletAddress.trim()).toLowerCase();
      } catch {
        return { data: null, error: "Invalid wallet", message: "Valid wallet address required", status: 400 };
      }

      if (!this.userId)
        return { data: null, error: "Unauthorized", message: "Authentication required", status: 401 };

      const existing = await UserModel.findById(this.userId);
      if (!existing)
        return { data: null, error: "Not found", message: "User not found", status: 404 };

      const list = new Set<string>(
        (existing.walletAddresses || [])
          .map((w: string) => (w || "").trim().toLowerCase())
          .filter(Boolean),
      );
      const primary = (existing.walletAddress || "").trim().toLowerCase();

      // Same account, same wallet (e.g. primary set but missing from walletAddresses — common with WalletConnect / OTP flows)
      if (primary === normalized || list.has(normalized)) {
        let patched = false;
        if (primary === normalized && !list.has(normalized)) {
          list.add(normalized);
          existing.walletAddresses = Array.from(list);
          patched = true;
        }
        if (patched) await existing.save();
        return {
          data: { walletAddress: existing.walletAddress, walletAddresses: existing.walletAddresses },
          error: null,
          message: "Wallet already linked",
          status: 200,
        };
      }

      // Use DB user id (not JWT string alone) so $ne never mis-fires and flags the same user as "another account".
      const selfId = existing._id;
      const conflict = await UserModel.findOne({
        _id: { $ne: selfId },
        $or: [{ walletAddress: normalized }, { walletAddresses: normalized }],
      });
      if (conflict)
        return { data: null, error: "Wallet in use", message: "This wallet is already linked to another account", status: 409 };

      list.add(normalized);
      existing.walletAddresses = Array.from(list);
      if (!existing.walletAddress) existing.walletAddress = normalized;
      await existing.save();

      logger.info(`[AUTH] Wallet linked: ${existing.email} → ${normalized}`);

      // If this user already has active deposits, attest their principal on-chain now that we
      // finally have a wallet to key it by. Non-blocking; the outbox worker sends it.
      void enqueueAttest(existing._id);

      return {
        data: { walletAddress: existing.walletAddress, walletAddresses: existing.walletAddresses },
        error: null,
        message: "Wallet linked",
        status: 200,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Failed to link wallet", status: 500 };
    }
  }
}