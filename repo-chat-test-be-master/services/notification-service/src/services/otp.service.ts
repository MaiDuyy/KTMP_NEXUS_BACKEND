// services/auth-service/src/services/otp.service.ts

import { publishEvent  } from "../lib/nats.js";
import { EventSubjects, type OtpEmailPayload, type OtpType } from "../lib/events.js";

type OtpRecord = {
  email: string;
  type: OtpType;
  otpCode: string;
  expiresAt: number;          // OTP valid until
  resendAvailableAt: number;  // next resend time
};

const OTP_TTL_MS = 5 * 60 * 1000;     // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

// key = `${type}:${email}`
const store = new Map<string, OtpRecord>();

function keyOf(email: string, type: OtpType) {
  return `${type}:${email.toLowerCase()}`;
}

function generateOTPCode(length: number = 6): string {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < length; i++) otp += digits[Math.floor(Math.random() * digits.length)];
  return otp;
}

function nowMs() {
  return Date.now();
}

export async function requestOtp(email: string, type: OtpType) {
  const otpCode = generateOTPCode(6);
  const now = nowMs();

  const record: OtpRecord = {
    email,
    type,
    otpCode,
    expiresAt: now + OTP_TTL_MS,
    resendAvailableAt: now + RESEND_COOLDOWN_MS,
  };

  store.set(keyOf(email, type), record);

  const payload: OtpEmailPayload = { email, otpCode, type };
  await publishEvent<OtpEmailPayload>(EventSubjects.OTP_SEND, payload);

  return {
    ok: true,
    resendAfterSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000),
    expiresInSeconds: Math.ceil(OTP_TTL_MS / 1000),
  };
}

export async function resendOtp(email: string, type: OtpType) {
  const k = keyOf(email, type);
  const rec = store.get(k);
  const now = nowMs();

  // Nếu chưa từng request -> coi như request mới
  if (!rec) {
    return requestOtp(email, type);
  }

  // OTP hết hạn -> tạo mới (và resend = gửi mới)
  if (now > rec.expiresAt) {
    return requestOtp(email, type);
  }

  // Chặn resend trước 60s
  if (now < rec.resendAvailableAt) {
    const waitMs = rec.resendAvailableAt - now;
    return {
      ok: false,
      error: "RESEND_TOO_SOON",
      resendAvailableInSeconds: Math.ceil(waitMs / 1000),
    };
  }

  // Resend: có thể giữ OTP cũ hoặc tạo OTP mới
  // Khuyến nghị: tạo OTP mới để an toàn
  const newOtp = generateOTPCode(6);

  const updated: OtpRecord = {
    ...rec,
    otpCode: newOtp,
    resendAvailableAt: now + RESEND_COOLDOWN_MS,
    expiresAt: now + OTP_TTL_MS, // reset TTL (tuỳ bạn muốn reset hay giữ TTL cũ)
  };

  store.set(k, updated);

  const payload: OtpEmailPayload = { email, otpCode: updated.otpCode, type };
  await publishEvent<OtpEmailPayload>(EventSubjects.OTP_SEND, payload);

  return {
    ok: true,
    resendAfterSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000),
    expiresInSeconds: Math.ceil((updated.expiresAt - now) / 1000),
  };
}

export function verifyOtp(email: string, type: OtpType, otpCode: string) {
  const k = keyOf(email, type);
  const rec = store.get(k);
  const now = nowMs();

  if (!rec) return { ok: false, error: "OTP_NOT_FOUND" };
  if (now > rec.expiresAt) return { ok: false, error: "OTP_EXPIRED" };

  if (rec.otpCode !== otpCode) return { ok: false, error: "OTP_INVALID" };

  // verify success -> xoá record
  store.delete(k);
  return { ok: true };
}
