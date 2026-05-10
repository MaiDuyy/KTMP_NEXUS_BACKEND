// src/config/auth.config.ts
// Cấu hình JWT Secret, thời gian hết hạn token và Cookie

const isProduction = process.env.NODE_ENV === "production";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (isProduction) {
  if (!JWT_SECRET) throw new Error("FATAL: JWT_SECRET is missing in production!");
  if (!JWT_REFRESH_SECRET) throw new Error("FATAL: JWT_REFRESH_SECRET is missing in production!");
} else {
  if (!JWT_SECRET) console.warn("⚠️ Using default JWT_SECRET for development.");
  if (!JWT_REFRESH_SECRET) console.warn("⚠️ Using default JWT_REFRESH_SECRET for development.");
}

export const authConfig = {
  // JWT secret for ACCESS tokens
  secret: JWT_SECRET || "your-super-secret-jwt-key-change-in-production",

  // SEPARATE secret for REFRESH tokens (prevents cross-use attacks)
  refreshSecret: JWT_REFRESH_SECRET || "your-refresh-secret-change-in-production",

  // Access token hết hạn sau 15 phút (production-standard)
  accessTokenExpiry: process.env.ACCESS_TOKEN_EXPIRY || "15m",

  // Refresh token hết hạn sau 7 ngày
  refreshTokenExpiry: "7d",

  // Refresh token TTL in milliseconds (for DB storage)
  refreshTokenTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Các role có trong hệ thống
  roles: ["USER", "ADMIN", "MODERATOR"] as const,

  // Cookie configuration
  cookie: {
    // Tên cookie cho access token
    accessTokenName: "accessToken",
    // Tên cookie cho refresh token
    refreshTokenName: "refreshToken",

    // Cookie options - QUAN TRỌNG!
    options: {
      httpOnly: true,           // Không cho JavaScript truy cập (bảo mật XSS)
      secure: isProduction,     // CHỈ true khi HTTPS (production), false cho localhost HTTP
      sameSite: "lax" as const, // "lax" cho phép cookie gửi khi navigate từ tab khác
      path: "/",                // Cookie áp dụng cho toàn bộ domain
      // domain: không set để mặc định là domain hiện tại
    },

    // Thời gian hết hạn cookie (tính bằng milliseconds)
    accessTokenMaxAge: 15 * 60 * 1000,           // 15 phút (match accessTokenExpiry)
    refreshTokenMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 ngày
  },
};

export type AccountRoleType = typeof authConfig.roles[number];
