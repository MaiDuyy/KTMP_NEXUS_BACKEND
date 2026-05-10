import { Router } from 'express';
import { workspaceDissolutionService } from '../services/workspace-dissolution.service.js';
import { workspaceService } from '../services/workspace.service.js'; 
import { logger } from '../lib/logger.js';

const router = Router();

// Luồng 1: Giải tán
router.post('/:id/dissolve', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { workspaceNameConfirm } = req.body;
    const userId = req.headers['x-user-id'] as string;

    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const result = await workspaceDissolutionService.dissolveWorkspace(id, userId, workspaceNameConfirm);
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

// Luồng 6: Khôi phục
router.post('/:id/restore', async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'] as string;

    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const result = await workspaceDissolutionService.restoreWorkspace(id, userId);
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

// Luồng 4: Tự rời
router.post('/:id/leave', async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'] as string;

    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const result = await workspaceService.leaveWorkspace(id, userId);
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

// Luồng 5: Kick
router.delete('/:id/members/:targetUserId', async (req, res, next) => {
  try {
    const { id, targetUserId } = req.params;
    const actorId = req.headers['x-user-id'] as string;

    if (!actorId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const result = await workspaceService.kickMember(id, targetUserId, actorId);
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

export const workspaceRoutes = router;
