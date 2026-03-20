
export * from "./auth.types.js";
export * from "./permission.types.js";

export interface RefreshToken {
  id: string;
  userId: string;
  jti: string;
  expiresAt: Date;
  createdAt: Date;
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
