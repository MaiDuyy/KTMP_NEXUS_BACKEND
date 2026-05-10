// services/auth-service/src/routes/otp.routes.ts

import { Router } from "express";
import type { Request, Response } from "express";
import { requestOtp, resendOtp, verifyOtp } from "../services/otp.service.js";
import type { OtpType } from "../lib/events.js";

export const otpRoutes = Router();

function parseType(v: any): OtpType {
  if (v === "VERIFY_EMAIL" || v === "RESET_PASSWORD" || v === "CHANGE_EMAIL") return v;
  return "VERIFY_EMAIL";
}

// POST /otp/request  { email, type }
otpRoutes.post("/request", async (req: Request, res: Response) => {
  const email = String(req.body?.email || "").trim();
  const type = parseType(req.body?.type);

  if (!email) return res.status(400).json({ ok: false, error: "EMAIL_REQUIRED" });

  const result = await requestOtp(email, type);
  return res.json(result);
});

// POST /otp/resend { email, type }
otpRoutes.post("/resend", async (req: Request, res: Response) => {
  const email = String(req.body?.email || "").trim();
  const type = parseType(req.body?.type);

  if (!email) return res.status(400).json({ ok: false, error: "EMAIL_REQUIRED" });

  const result = await resendOtp(email, type);

  // Nếu resend quá sớm -> trả 429
  if ("error" in result && result.error === "RESEND_TOO_SOON") {
    return res.status(429).json(result);
  }

  return res.json(result);
});

// POST /otp/verify { email, type, otpCode }
otpRoutes.post("/verify", (req: Request, res: Response) => {
  const email = String(req.body?.email || "").trim();
  const type = parseType(req.body?.type);
  const otpCode = String(req.body?.otpCode || "").trim();

  if (!email) return res.status(400).json({ ok: false, error: "EMAIL_REQUIRED" });
  if (!otpCode) return res.status(400).json({ ok: false, error: "OTP_REQUIRED" });

  const result = verifyOtp(email, type, otpCode);
  return res.status(result.ok ? 200 : 400).json(result);
});
