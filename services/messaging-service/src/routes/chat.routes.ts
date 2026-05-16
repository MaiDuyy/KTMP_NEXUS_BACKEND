// services/messaging-service/src/routes/chat.routes.ts
// Chat/Group routes — migrated from group-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { chatService } from '../services/chat.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AccessToken } from 'livekit-server-sdk';

export const chatRoutes = Router();

// Internal endpoints (for ws-gateway fan-out)
chatRoutes.get('/internal/:chatId/participant-ids', asyncHandler(async (req: Request, res: Response) => {
  const { chatId } = req.params;
  const participantIds = await chatService.getParticipantIds(chatId as string);
  res.json({ success: true, participantIds });
}));

chatRoutes.get('/internal/:chatId/metadata', asyncHandler(async (req: Request, res: Response) => {
  const { chatId } = req.params;
  const chat = await chatService.getChatMetadataInternal(chatId as string);
  res.json({ success: true, chat });
}));

// GET /unread-counts — Lấy tổng số tin nhắn chưa đọc theo từng workspace
chatRoutes.get('/unread-counts', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const counts = await chatService.getUnreadCountsPerWorkspace(userId);
  res.json({ success: true, counts });
}));

// GET / — Lấy danh sách chat
chatRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const workspaceId = req.headers['x-workspace-id'] as string;
  const { type } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const chats = await chatService.getChats(userId, type as any, workspaceId);
  res.json({ success: true, chats });
}));

// GET /:chatId
chatRoutes.get('/:chatId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const chat = await chatService.getChatById(chatId as string, userId);
  res.json({ success: true, chat });
}));

// GET /:chatId/call/token — Generate LiveKit token
chatRoutes.get('/:chatId/call/token', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const participantName = `User-${userId.substring(0, 5)}`;
  const roomName = `chat-${chatId}`;
  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  const at = new AccessToken(apiKey, apiSecret, { identity: userId, name: participantName, ttl: '1h' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const token = await at.toJwt();
  res.json({ success: true, token });
}));

// POST /group — Tạo nhóm chat mới
chatRoutes.post('/group', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const workspaceId = req.headers['x-workspace-id'] as string;
  const { name, avatar, memberIds, joinPolicy } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const chat = await chatService.createGroupChat(userId, name, memberIds, { avatar, joinPolicy }, workspaceId);
  res.status(201).json({ success: true, message: 'Tạo nhóm thành công!', chat });
}));

// POST /:chatId/join — Tham gia nhóm hoặc gửi yêu cầu duyệt
chatRoutes.post('/:chatId/join', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await chatService.joinGroup(chatId as string, userId);
  res.json({ success: true, ...result });
}));

// POST /:chatId/join-requests/:targetAccountId/approve — Duyệt/Từ chối yêu cầu tham gia
chatRoutes.post('/:chatId/join-requests/:targetAccountId/approve', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId, targetAccountId } = req.params;
  const { approve } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await chatService.approveJoinRequest(chatId as string, userId, targetAccountId as string, approve);
  res.json({ success: true, message: approve ? 'Đã duyệt yêu cầu!' : 'Đã từ chối yêu cầu!' });
}));

// POST /private — Tìm hoặc tạo chat 1-1
chatRoutes.post('/private', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const workspaceId = req.headers['x-workspace-id'] as string;
  const { partnerId } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!partnerId) return res.status(400).json({ success: false, message: 'Vui lòng chọn người chat!' });
  const result = await chatService.getOrCreatePrivateChat(userId, partnerId, workspaceId);
  res.status(result.created ? 201 : 200).json({ success: true, ...result });
}));

// PUT /:chatId
chatRoutes.put('/:chatId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { name, avatar, joinPolicy, isReadOnly } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const chat = await chatService.updateChat(chatId as string, userId, { name, avatar, joinPolicy, isReadOnly });
  res.json({ success: true, message: 'Cập nhật nhóm thành công!', chat });
}));

// POST /:chatId/members
chatRoutes.post('/:chatId/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { memberIds } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) return res.status(400).json({ success: false, message: 'Vui lòng chọn thành viên!' });
  const result = await chatService.addMembers(chatId as string, userId, memberIds);
  res.json({ success: true, message: `Đã thêm ${result.addedCount} thành viên!` });
}));

// DELETE /:chatId/members/:memberId
chatRoutes.delete('/:chatId/members/:memberId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId, memberId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await chatService.removeMember(chatId as string, userId, memberId as string);
  res.json({ success: true, message: result.isSelfLeave ? 'Đã rời khỏi nhóm!' : 'Đã xóa thành viên!' });
}));

// POST /:chatId/leave
chatRoutes.post('/:chatId/leave', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await chatService.removeMember(chatId as string, userId, userId);
  res.json({ success: true, message: 'Đã rời khỏi nhóm!' });
}));

// PUT /:chatId/members/:memberId/role
chatRoutes.put('/:chatId/members/:memberId/role', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId, memberId } = req.params;
  const { role } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!role) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp quyền hạn mới!' });
  await chatService.updateMemberRole(chatId as string, userId, memberId as string, role);
  res.json({ success: true, message: 'Cập nhật quyền thành viên thành công!' });
}));

// PUT /:chatId/pin
chatRoutes.put('/:chatId/pin', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { pin } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await chatService.togglePin(chatId as string, userId, pin);
  res.json({ success: true, message: result.pin ? 'Đã ghim chat!' : 'Đã bỏ ghim chat!', ...result });
}));

// PUT /:chatId/notify
chatRoutes.put('/:chatId/notify', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { notify } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await chatService.toggleNotify(chatId as string, userId, notify);
  res.json({ success: true, message: result.notify ? 'Đã bật thông báo!' : 'Đã tắt thông báo!', ...result });
}));

// PUT /:chatId/read
chatRoutes.put('/:chatId/read', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await chatService.markAsRead(chatId as string, userId);
  res.json({ success: true, message: 'Đã đánh dấu đã đọc!' });
}));

// GET /:chatId/receipts — Lấy danh sách Read Receipts
chatRoutes.get('/:chatId/receipts', asyncHandler(async (req: Request, res: Response) => {
  const { chatId } = req.params;
  const receipts = await chatService.getReadReceipts(chatId as string);
  res.json({ success: true, receipts });
}));

// DELETE /:chatId
chatRoutes.delete('/:chatId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await chatService.deleteChat(chatId as string, userId);
  res.json({ success: true, message: result.type === 'soft_delete' ? 'Đã xóa cuộc trò chuyện!' : 'Đã xóa nhóm!', type: result.type });
}));

// ================= TASK ROUTES =================
import { taskService } from '../services/task.service.js';

// POST /:chatId/tasks — Tạo task mới
chatRoutes.post('/:chatId/tasks', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { title, description, deadlineAt, startAt, assigneeIds } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const task = await taskService.createTask(chatId as string, userId, { title, description, deadlineAt, startAt }, assigneeIds || []);
  res.status(201).json({ success: true, message: 'Tạo kế hoạch thành công!', task });
}));

// GET /:chatId/tasks — Lấy danh sách task trong nhóm
chatRoutes.get('/:chatId/tasks', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const tasks = await taskService.getTasks(chatId as string);
  res.json({ success: true, tasks });
}));

// PATCH /tasks/:taskId/status — Cập nhật trạng thái task
chatRoutes.patch('/tasks/:taskId/status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { taskId } = req.params;
  const { status, chatId } = req.body; // chatId for cache invalidation or checks
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const task = await taskService.updateTaskStatus(taskId as string, userId, status);
  res.json({ success: true, message: 'Cập nhật trạng thái thành công!', task });
}));

// DELETE /tasks/:taskId — Xóa task
chatRoutes.delete('/tasks/:taskId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { taskId } = req.params;
  const { chatId } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await taskService.deleteTask(taskId as string, userId, chatId as string);
  res.json({ success: true, message: 'Đã xóa kế hoạch!' });
}));
