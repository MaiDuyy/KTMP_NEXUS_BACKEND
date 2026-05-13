// services/identity-service/src/config/auth.config.ts

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
  secret: JWT_SECRET || "your-super-secret-jwt-key-change-in-production",
  refreshSecret: JWT_REFRESH_SECRET || "your-refresh-secret-change-in-production",
  accessTokenExpiry: process.env.ACCESS_TOKEN_EXPIRY || "15m",
  refreshTokenExpiry: "7d",
  refreshTokenTtlMs: 7 * 24 * 60 * 60 * 1000,
  roles: ["SUPER_ADMIN", "ADMIN", "WORKSPACE_MANAGER", "EMPLOYEE"] as const,
  cookie: {
    accessTokenName: "accessToken",
    refreshTokenName: "refreshToken",
    options: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax" as const,
      path: "/",
    },
    accessTokenMaxAge: 15 * 60 * 1000,
    refreshTokenMaxAge: 7 * 24 * 60 * 60 * 1000,
  },
};

export type AccountRoleType = typeof authConfig.roles[number];
