// src/config/email.config.ts
// Cấu hình email SMTP cho việc gửi OTP

export const emailConfig = {
  // SMTP Configuration
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    },
  },

  // Sender information
  from: {
    name: process.env.EMAIL_FROM_NAME || "Chat App",
    address: process.env.EMAIL_FROM_ADDRESS || "noreply@chatapp.com",
  },

  // OTP Configuration
  otp: {
    // Độ dài mã OTP
    length: 6,
    // Thời gian hết hạn OTP (tính bằng phút)
    expiryMinutes: 5,
    // Số lần thử tối đa
    maxAttempts: 5,
    // Thời gian chờ giữa các lần gửi OTP (tính bằng giây)
    resendCooldown: 60,
  },
};
