// src/config/auth.config.ts
// Cấu hình JWT Secret, thời gian hết hạn token và Cookie

const isProduction = process.env.NODE_ENV === "production";

export const authConfig = {
  // JWT secret key - trong production nên lưu trong biến môi trường
  secret: process.env.JWT_SECRET || "your-super-secret-jwt-key-change-in-production",
  
  // Access token hết hạn sau 24 giờ
  accessTokenExpiry: "24h",
  
  // Refresh token hết hạn sau 7 ngày
  refreshTokenExpiry: "7d",
  
  // Các role có trong hệ thống
  roles: ["USER", "ADMIN", "MODERATOR"] as const,

  // Cookie configuration - SỬA LẠI CHO ĐÚNG
  cookie: {
    // Tên cookie cho access token
    accessTokenName: "accessToken",
    // Tên cookie cho refresh token
    refreshTokenName: "refreshToken",
    
    // Cookie options - QUAN TRỌNG!
    options: {
      httpOnly: true,           // Không cho JavaScript truy cập (bảo mật XSS)
      secure: true,     // CHỈ true khi HTTPS (production), false cho localhost HTTP
      sameSite: "lax" as const, // "lax" cho phép cookie gửi khi navigate từ tab khác
      path: "/",                // Cookie áp dụng cho toàn bộ domain
      // domain: không set để mặc định là domain hiện tại
    },
    
    // Thời gian hết hạn cookie (tính bằng milliseconds)
    accessTokenMaxAge: 24 * 60 * 60 * 1000,     // 24 giờ
    refreshTokenMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 ngày
  },
};

export type AccountRoleType = typeof authConfig.roles[number];
