// services/notification-service/src/services/email.service.ts
// Email service using Nodemailer

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '../lib/logger.js';
import type { OtpEmailPayload, OtpType } from '../lib/events.js';

const smtpConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
};

const emailFrom = process.env.EMAIL_FROM || 'OTT Chat <noreply@ottchat.com>';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport(smtpConfig);
  }
  return transporter;
}

function getOtpSubject(type: OtpType): string {
  switch (type) {
    case 'VERIFY_EMAIL':
      return 'Xác thực tài khoản OTT Chat';
    case 'RESET_PASSWORD':
      return 'Đặt lại mật khẩu OTT Chat';
    case 'CHANGE_EMAIL':
      return 'Thay đổi email OTT Chat';
    default:
      return 'Mã xác thực OTT Chat';
  }
}

function getOtpHtml(otpCode: string, type: OtpType): string {
  const actionText = type === 'VERIFY_EMAIL' 
    ? 'xác thực tài khoản' 
    : type === 'RESET_PASSWORD' 
    ? 'đặt lại mật khẩu' 
    : 'thay đổi email';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OTP Verification</title>
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 24px;">OTT Chat</h1>
    </div>
    <div style="padding: 32px; text-align: center;">
      <h2 style="color: #333; margin: 0 0 16px;">Mã xác thực của bạn</h2>
      <p style="color: #666; margin: 0 0 24px;">Sử dụng mã dưới đây để ${actionText}</p>
      <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 0 0 24px;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #667eea;">${otpCode}</span>
      </div>
      <p style="color: #999; font-size: 14px; margin: 0;">Mã có hiệu lực trong <strong>5 phút</strong>.</p>
      <p style="color: #999; font-size: 14px; margin: 8px 0 0;">Nếu bạn không yêu cầu mã này, vui lòng bỏ qua email.</p>
    </div>
    <div style="background: #f8f9fa; padding: 16px; text-align: center; border-top: 1px solid #eee;">
      <p style="color: #999; font-size: 12px; margin: 0;">© 2026 OTT Chat. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

export const emailService = {
  async sendOtpEmail({ email, otpCode, type }: OtpEmailPayload): Promise<boolean> {
    try {
      const transport = getTransporter();
      
      const mailOptions = {
        from: emailFrom,
        to: email,
        subject: getOtpSubject(type),
        html: getOtpHtml(otpCode, type),
      };

      const info = await transport.sendMail(mailOptions);
      logger.info({ messageId: info.messageId, email, type }, 'OTP email sent successfully');
      return true;
    } catch (error) {
      logger.error({ error, email, type }, 'Failed to send OTP email');
      return false;
    }
  },

  async sendInvitationEmail(payload: { 
    to: string; 
    data: { 
      inviteUrl: string; 
      inviterName: string; 
      orgName: string; 
      expiresAt: string; 
      type: string; 
    } 
  }): Promise<boolean> {
    try {
      const transport = getTransporter();
      const { to, data } = payload;
      
      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invitation to join ${data.orgName}</title>
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden;">
    <div style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 40px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 800;">OTT Chat</h1>
      <p style="color: rgba(255,255,255,0.9); margin-top: 8px;">Mời tham gia tổ chức</p>
    </div>
    <div style="padding: 40px;">
      <h2 style="color: #1f2937; margin: 0 0 20px; font-size: 22px; text-align: center;">Chào mừng bạn!</h2>
      <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
        <strong>${data.inviterName}</strong> đã mời bạn tham gia vào tổ chức <strong>${data.orgName}</strong> với vai trò là <strong>${data.type}</strong>.
      </p>
      <div style="text-align: center; margin-bottom: 32px;">
        <a href="${data.inviteUrl}" style="display: inline-block; background-color: #4f46e5; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; transition: background-color 0.2s;">
          Chấp nhận lời mời
        </a>
      </div>
      <p style="color: #6b7280; font-size: 14px; margin: 0 0 12px;">
        Lời mời này sẽ hết hạn vào: <strong>${new Date(data.expiresAt).toLocaleDateString('vi-VN')}</strong>
      </p>
      <p style="color: #9ca3af; font-size: 12px; margin: 0; border-top: 1px solid #eee; padding-top: 20px;">
        Nếu nút trên không hoạt động, hãy copy đường dẫn sau vào trình duyệt: <br>
        <span style="color: #4f46e5; word-break: break-all;">${data.inviteUrl}</span>
      </p>
    </div>
    <div style="background: #f9fafb; padding: 24px; text-align: center; border-top: 1px solid #eee;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">© 2026 OTT Chat. Tất cả quyền lợi được bảo lưu.</p>
    </div>
  </div>
</body>
</html>
      `.trim();

      const mailOptions = {
        from: emailFrom,
        to,
        subject: `Mời tham gia ${data.orgName}`,
        html,
      };

      const info = await transport.sendMail(mailOptions);
      logger.info({ messageId: info.messageId, to }, 'Invitation email sent successfully');
      return true;
    } catch (error: any) {
      logger.error({ 
        error: error.message || error, 
        stack: error.stack,
        to: payload.to 
      }, 'Failed to send invitation email');
      return false;
    }
  },

  async verifyConnection(): Promise<boolean> {
    try {
      const transport = getTransporter();
      await transport.verify();
      logger.info('SMTP connection verified');
      return true;
    } catch (error) {
      logger.warn({ error }, 'SMTP connection failed - emails will not be sent');
      return false;
    }
  },
};
