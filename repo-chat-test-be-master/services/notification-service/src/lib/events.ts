
export const EventSubjects = {
  OTP_SEND: "otp.send",
} as const;

export type OtpType = "VERIFY_EMAIL" | "RESET_PASSWORD" | "CHANGE_EMAIL";

export interface OtpEmailPayload {
  email: string;
  otpCode: string;
  type: OtpType;
}
