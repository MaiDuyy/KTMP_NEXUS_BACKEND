import { Router } from 'express';
import type { Request, Response } from 'express';
import { pollService } from '../services/poll.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const pollRoutes = Router();

// POST /polls - Tạo cuộc bình chọn mới
pollRoutes.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId, title, options, endsAt } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!chatId) {
    return res.status(400).json({ success: false, message: 'chatId là bắt buộc!' });
  }

  const poll = await pollService.createPoll(chatId, userId, { title, options, endsAt });

  res.status(201).json({
    success: true,
    poll,
  });
}));

// GET /polls/:id - Lấy thông tin chi tiết cuộc bình chọn
pollRoutes.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const poll = await pollService.getPoll(id, userId);

  res.json({
    success: true,
    poll,
  });
}));

// POST /polls/:id/vote - Thực hiện bình chọn phương án
pollRoutes.post('/:id/vote', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;
  const { optionId } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!optionId) {
    return res.status(400).json({ success: false, message: 'optionId là bắt buộc!' });
  }

  const poll = await pollService.vote(id, userId, optionId);

  res.json({
    success: true,
    poll,
  });
}));
