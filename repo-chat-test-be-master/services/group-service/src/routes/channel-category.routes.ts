// services/group-service/src/routes/channel-category.routes.ts
// Channel Category management endpoints (WS-08)

import { Router } from 'express';
import type { Request, Response } from 'express';
import { channelCategoryService } from '../services/channel-category.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const channelCategoryRoutes = Router();

/**
 * POST /workspaces/:wsId/categories - Create category
 */
channelCategoryRoutes.post('/workspaces/:wsId/categories', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { name, position } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!name) {
    return res.status(400).json({ success: false, message: 'Tên category là bắt buộc!' });
  }

  const category = await channelCategoryService.createCategory(wsId as string, { name, position }, userId);

  res.status(201).json({
    success: true,
    message: 'Tạo category thành công!',
    category,
  });
}));

/**
 * GET /workspaces/:wsId/categories - List categories
 */
channelCategoryRoutes.get('/workspaces/:wsId/categories', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const categories = await channelCategoryService.listCategories(wsId as string, userId);

  res.json({
    success: true,
    categories,
  });
}));

/**
 * PUT /categories/:id - Update category
 */
channelCategoryRoutes.put('/categories/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { name, position } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const category = await channelCategoryService.updateCategory(id as string,  { name, position }, userId);

  res.json({
    success: true,
    message: 'Cập nhật category thành công!',
    category,
  });
}));

/**
 * DELETE /categories/:id - Delete category
 */
channelCategoryRoutes.delete('/categories/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await channelCategoryService.deleteCategory(id as string, userId);

  res.json({
    success: true,
    message: 'Xóa category thành công!',
  });
}));

/**
 * PUT /workspaces/:wsId/categories/reorder - Reorder categories
 */
channelCategoryRoutes.put('/workspaces/:wsId/categories/reorder', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { categoryIds } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!categoryIds || !Array.isArray(categoryIds)) {
    return res.status(400).json({ success: false, message: 'categoryIds là bắt buộc!' });
  }

  await channelCategoryService.reorderCategories(wsId as string, categoryIds, userId);

  res.json({
    success: true,
    message: 'Sắp xếp category thành công!',
  });
}));

/**
 * PUT /categories/:id/channels/reorder - Reorder channels in category
 */
channelCategoryRoutes.put('/categories/:id/channels/reorder', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { channelIds } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!channelIds || !Array.isArray(channelIds)) {
    return res.status(400).json({ success: false, message: 'channelIds là bắt buộc!' });
  }

  await channelCategoryService.reorderChannelsInCategory(id as string, channelIds, userId);

  res.json({
    success: true,
    message: 'Sắp xếp channels thành công!',
  });
}));

/**
 * PUT /channels/:id/category - Move channel to category
 */
channelCategoryRoutes.put('/channels/:channelId/category', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { channelId } = req.params;
  const { categoryId } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const channel = await channelCategoryService.moveChannelToCategory(channelId as string, categoryId, userId);

  res.json({
    success: true,
    message: categoryId ? 'Đã di chuyển channel vào category!' : 'Đã bỏ channel khỏi category!',
    channel,
  });
}));
