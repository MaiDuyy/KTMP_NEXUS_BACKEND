// src/config/upload.config.ts
// Cấu hình Cloudinary cho việc upload file (avatar, images, etc.)

export const uploadConfig = {
  // Cloudinary Configuration
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
  },

  // Kích thước tối đa file upload (bytes)
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || "5242880"), // 5MB

  // Các định dạng file ảnh cho phép
  allowedImageTypes: ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"],

  // Các extension cho phép
  allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],

  // Cấu hình avatar
  avatar: {
    // Folder trên Cloudinary
    folder: "chat-app/avatars",
    // Kích thước tối đa của avatar (pixels)
    maxWidth: 500,
    maxHeight: 500,
    // Số lượng avatar tối đa mỗi user có thể lưu
    maxAvatars: 5,
    // Transformation cho avatar
    transformation: {
      width: 500,
      height: 500,
      crop: "fill",
      gravity: "face",
      quality: "auto",
      format: "webp",
    },
  },
};

