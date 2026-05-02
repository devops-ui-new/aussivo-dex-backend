import { Request, Response } from "express";
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
import { JWT_SECRET, VAULT_CONTRACT_ADDRESS, USDT_CONTRACT_ADDRESS, USDC_CONTRACT_ADDRESS, BSC_CHAIN_ID } from "../configs/constants";
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

      const user = await UserModel.findOne({
        walletAddress: walletAddress.toLowerCase(),
        status: "active",
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

      const token = jwt.sign(
        { id: user._id, email: user.email, role: "user" },
        JWT_SECRET,
        { expiresIn: "7d" },
      );

      return {
        data: {
          token,
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

  // ── DEPOSIT (with QR code generation) ──
  async getDepositQR(body: {
    vaultId: string;
    amount: number;
  }): Promise<IResponse> {
    try {
      const { vaultId, amount } = body;
      const vault = await VaultModel.findById(vaultId);
      if (!vault || vault.status !== "active")
        return {
          data: null,
          error: "Vault not available",
          message: "Vault not found or inactive",
          status: 404,
        };
      if (amount < vault.minDeposit)
        return {
          data: null,
          error: "Below minimum",
          message: `Minimum deposit is $${vault.minDeposit}`,
          status: 400,
        };
      if (amount > vault.maxDeposit)
        return {
          data: null,
          error: "Above maximum",
          message: `Maximum deposit is $${vault.maxDeposit}`,
          status: 400,
        };
      if (vault.totalStaked + amount > vault.capacity)
        return {
          data: null,
          error: "Vault full",
          message: "Vault capacity reached",
          status: 400,
        };

      // Deployed AussivoVault contract on BSC — users send USDT/USDC here.
      // DepositListener watches for ERC-20 Transfer events to this address.
      const depositAddress = VAULT_CONTRACT_ADDRESS;
      if (!depositAddress) {
        return {
          data: null,
          error: "Vault contract not configured",
          message: "Vault contract address not set",
          status: 500,
        };
      }

      // BSC BEP-20 token contracts (USDT & USDC both use 18 decimals on BSC)
      const TOKEN_ADDRESSES: Record<string, string> = {
        USDT: USDT_CONTRACT_ADDRESS,
        USDC: USDC_CONTRACT_ADDRESS,
      };
      const tokenAddress = TOKEN_ADDRESSES[vault.asset];
      const decimals = 18;
      const amountInBaseUnits = BigInt(Math.round(amount * 10 ** 6)) * BigInt(10 ** (decimals - 6));
      const requestId = `0x${randomBytes(32).toString("hex")}`;

      const depositFunction =
        vault.asset === "USDT" ? "depositUSDTWithRequest" : "depositUSDCWithRequest";
      const iface = new ethers.Interface([
        "function depositUSDTWithRequest(uint256 amount, string vaultId, bytes32 requestId)",
        "function depositUSDCWithRequest(uint256 amount, string vaultId, bytes32 requestId)",
      ]);
      const txData = iface.encodeFunctionData(depositFunction, [
        amountInBaseUnits,
        vaultId,
        requestId,
      ]);
      // Wallet scanner-safe QR (non-EIP-681): plain address.
      const qrPayload = depositAddress;
      const qrPayloadAddressOnly = depositAddress;

      const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
        width: 300,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      // Per-vault routing: record a pending deposit intent so the listener
      // credits the transfer to the vault the user actually chose.
      const user = await UserModel.findById(this.userId);
      const depositWallet = (
        (body as any).walletAddress ||
        user?.walletAddress ||
        (user?.walletAddresses || [])[0] ||
        ""
      ).toLowerCase();
      if (!depositWallet || !depositWallet.startsWith("0x")) {
        return {
          data: null,
          error: "No wallet address",
          message: "Connect a wallet before depositing",
          status: 400,
        };
      }
      const INTENT_TTL_MS = 60 * 60 * 1000; // 1 hour
      await PendingDepositModel.create({
        userId: this.userId,
        vaultId,
        expectedAmount: amount,
        expectedAmountBaseUnits: amountInBaseUnits.toString(),
        requestId,
        asset: vault.asset,
        walletAddress: depositWallet,
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      });

      return {
        data: {
          qrCode: qrCodeDataUrl,
          qrPayload,
          qrPayloadAddressOnly,
          tx: {
            to: depositAddress,
            value: "0x0",
            data: txData,
            chainId: BSC_CHAIN_ID,
            chainIdHex: `0x${BSC_CHAIN_ID.toString(16)}`,
          },
          depositAddress,
          tokenAddress,
          amount,
          /** Exact on-chain uint256; wallet pay flow should use this to avoid float/parseUnit drift. */
          amountInBaseUnits: amountInBaseUnits.toString(),
          requestId,
          vaultContractAddress: depositAddress,
          depositFunction,
          asset: vault.asset,
          network: BSC_CHAIN_ID === 56 ? "BNB Smart Chain (BEP-20)" : "BSC Testnet (BEP-20, chainId 97)",
          chainId: BSC_CHAIN_ID,
          chainIdHex: `0x${BSC_CHAIN_ID.toString(16)}`,
          vaultName: vault.name,
          memo: `vault:${vaultId}:user:${this.userId}`,
          instructions: [
            `Switch your wallet to ${BSC_CHAIN_ID === 56 ? "BNB Smart Chain (chainId 56 / 0x38)" : "BSC Testnet (chainId 97 / 0x61)"} BEFORE scanning`,
            "QR is plain vault address for maximum scanner compatibility",
            `Use in-app wallet button to sign ${depositFunction}(amount, vaultId, requestId)`,
            `If ${vault.asset} isn't recognized, add it as a custom token first: ${tokenAddress}`,
            "Confirm the transaction — deposit auto-confirms after on-chain confirmation",
          ],
        },
        error: null,
        message: "Deposit QR generated",
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

  // ── RECORD DEPOSIT (called after on-chain confirmation or manual admin approval) ──
  async recordDeposit(body: {
    vaultId: string;
    amount: number;
    txHash?: string;
  }): Promise<IResponse> {
    try {
      const { vaultId, amount, txHash } = body;
      const user = await UserModel.findById(this.userId);
      if (!user)
        return {
          data: null,
          error: "User not found",
          message: "User not found",
          status: 404,
        };

      const vault = await VaultModel.findById(vaultId);
      if (!vault || vault.status !== "active")
        return {
          data: null,
          error: "Vault not available",
          message: "Vault not available",
          status: 400,
        };

      // Determine tier
      let tierIndex = 0;
      let apyPercent = vault.tiers[0]?.apyPercent || 0;
      for (let i = vault.tiers.length - 1; i >= 0; i--) {
        if (amount >= vault.tiers[i].minAmount) {
          tierIndex = i;
          apyPercent = vault.tiers[i].apyPercent;
          break;
        }
      }

      const lockUntil =
        vault.lockDays > 0
          ? new Date(Date.now() + vault.lockDays * 86400000)
          : null;

      const deposit = await DepositModel.create({
        userId: user._id,
        vaultId: vault._id,
        amount,
        asset: vault.asset,
        txHash: txHash || "",
        walletAddress: user.walletAddress,
        lockUntil,
        apyPercent,
        tierIndex,
        maxYieldPayments: vault.durationMonths,
      });

      // Update vault TVL
      await VaultModel.findByIdAndUpdate(vault._id, {
        $inc: { totalStaked: amount, totalUsers: 1 },
      });

      // Update user balance
      const balField = vault.asset === "USDT" ? "usdtBalance" : "usdcBalance";
      await UserModel.findByIdAndUpdate(user._id, {
        $inc: { [balField]: amount, totalDeposited: amount },
      });

      await ActivityModel.create({
        userId: user._id,
        title: "Deposit Confirmed",
        description: `$${amount} ${vault.asset} deposited into ${vault.name}`,
        type: "deposit",
        metadata: { vaultId, depositId: deposit._id, amount },
      });

      return {
        data: {
          depositId: deposit._id,
          amount,
          asset: vault.asset,
          vault: vault.name,
          apyPercent,
          lockUntil,
        },
        error: null,
        message: "Deposit recorded successfully",
        status: 201,
      };
    } catch (err: any) {
      return {
        data: null,
        error: err.message,
        message: "Deposit failed",
        status: 500,
      };
    }
  }

  // ── USER DEPOSITS ──
  async getDeposits(page = 1, limit = 10): Promise<IResponse> {
    try {
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
        const tierMonthly = v.tiers?.[0]?.apyPercent || 0;
        const poolApy =
          v.displayApy != null ? Number(v.displayApy) : tierMonthly * 12;
        const poolApyMonthly =
          v.displayApyMonthly != null
            ? Number(v.displayApyMonthly)
            : v.displayApy != null
            ? Number(v.displayApy) / 12
            : tierMonthly;
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
            commissionRate: "0.35%",
          },
          l2: {
            count: l2Referrals.length,
            users: l2Referrals,
            commissionRate: "0.15%",
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
      const { amount, asset, source, walletAddress, depositId } = body;
      const user = await UserModel.findById(this.userId);
      if (!user)
        return {
          data: null,
          error: "Not found",
          message: "User not found",
          status: 404,
        };

      // ── DEPOSIT (principal) redemption ──
      if (source === "deposit") {
        if (!depositId)
          return { data: null, error: "Missing depositId", message: "depositId is required for deposit redemption", status: 400 };

        const deposit = await DepositModel.findById(depositId);
        if (!deposit || String(deposit.userId) !== String(user._id))
          return { data: null, error: "Not found", message: "Deposit not found", status: 404 };
        if (deposit.status !== "active")
          return { data: null, error: "Invalid state", message: "Deposit is not redeemable", status: 400 };
        if (deposit.lockUntil && new Date(deposit.lockUntil) > new Date())
          return { data: null, error: "Locked", message: "Deposit is still locked", status: 400 };

        const existing = await WithdrawRequestModel.findOne({ depositId: deposit._id, status: "pending" });
        if (existing)
          return { data: null, error: "Duplicate", message: "Redemption already requested for this deposit", status: 400 };

        const request = await WithdrawRequestModel.create({
          userId: user._id,
          amount: deposit.amount,
          asset: deposit.asset,
          walletAddress,
          source: "deposit",
          depositId: deposit._id,
        });

        return { data: request, error: null, message: "Redemption request submitted", status: 201 };
      }

      // ── YIELD / REFERRAL off-chain balance withdrawals ──
      let balanceField = "";
      if (source === "yield")
        balanceField = asset === "USDT" ? "yieldWalletUSDT" : "yieldWalletUSDC";
      else if (source === "referral") balanceField = "referralEarnings";
      else
        return {
          data: null,
          error: "Invalid source",
          message: "Invalid withdrawal source",
          status: 400,
        };

      if ((user as any)[balanceField] < amount) {
        return {
          data: null,
          error: "Insufficient",
          message: "Insufficient balance",
          status: 400,
        };
      }

      const request = await WithdrawRequestModel.create({
        userId: user._id,
        amount,
        asset,
        walletAddress,
        source,
      });

      // Deduct from balance immediately (pending state)
      await UserModel.findByIdAndUpdate(user._id, {
        $inc: { [balanceField]: -amount },
      });

      return {
        data: request,
        error: null,
        message: "Withdrawal request submitted",
        status: 201,
      };
    } catch (err: any) {
      return { data: null, error: err.message, message: "Error", status: 500 };
    }
  }

  /**
   * Direct wallet authentication for returning users.
   * If wallet is registered → issue JWT immediately (no OTP).
   * First-time users must go through email+OTP registration.
   */
  async walletAuth(body: { walletAddress: string }): Promise<IResponse> {
    try {
      const { walletAddress } = body;
      if (!walletAddress)
        return {
          data: null,
          error: "Wallet required",
          message: "Wallet address required",
          status: 400,
        };

      const user = await UserModel.findOne({
        walletAddress: walletAddress.toLowerCase(),
        status: "active",
      });
      if (!user) {
        // Not registered — frontend should show registration form
        return {
          data: { registered: false },
          error: null,
          message: "Wallet not registered",
          status: 200,
        };
      }

      // Returning user — issue JWT directly, no OTP needed
      const token = jwt.sign(
        { id: user._id, email: user.email, role: "user" },
        JWT_SECRET,
        { expiresIn: "7d" },
      );

      logger.info(
        `[AUTH] Wallet auto-login: ${user.email} (${walletAddress.slice(0, 10)}...)`,
      );

      return {
        data: {
          registered: true,
          token,
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            walletAddress: user.walletAddress,
            referralCode: user.referralCode,
          },
        },
        error: null,
        message: "Welcome back!",
        status: 200,
      };
    } catch (err: any) {
      logger.error("walletAuth error:", err);
      return {
        data: null,
        error: err.message,
        message: "Authentication failed",
        status: 500,
      };
    }
  }

  // ── LINK WALLET ADDRESS ──
  // Adds a wallet to the user's walletAddresses list. If the user has no primary
  // wallet yet, the new address becomes primary. A single wallet cannot be linked
  // to two emails.
  async linkWallet(body: { walletAddress: string }): Promise<IResponse> {
    try {
      const { walletAddress } = body;
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress))
        return { data: null, error: "Invalid wallet", message: "Valid wallet address required", status: 400 };

      const normalized = walletAddress.toLowerCase();

      const existing = await UserModel.findById(this.userId);
      if (!existing)
        return { data: null, error: "Not found", message: "User not found", status: 404 };

      const list = new Set<string>((existing.walletAddresses || []).map((w: string) => (w || "").toLowerCase()));
      const primary = (existing.walletAddress || "").toLowerCase();

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

      const conflict = await UserModel.findOne({
        _id: { $ne: this.userId },
        $or: [{ walletAddress: normalized }, { walletAddresses: normalized }],
      });
      if (conflict)
        return { data: null, error: "Wallet in use", message: "This wallet is already linked to another account", status: 409 };

      list.add(normalized);
      existing.walletAddresses = Array.from(list);
      if (!existing.walletAddress) existing.walletAddress = normalized;
      await existing.save();

      logger.info(`[AUTH] Wallet linked: ${existing.email} → ${normalized}`);
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
