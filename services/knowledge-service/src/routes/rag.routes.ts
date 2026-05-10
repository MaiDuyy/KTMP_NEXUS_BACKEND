import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ragService } from '../services/rag.service.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// POST /rag/query - Execute permission-aware RAG query
const ragQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  userId: z.string().uuid(),
  options: z.object({
    maxResults: z.number().int().min(1).max(20).optional(),
    minScore: z.number().min(0).max(1).optional(),
    collections: z.array(z.string().uuid()).optional(),
  }).optional(),
});

router.post('/query', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query, userId, options } = ragQuerySchema.parse(req.body);
    
    const response = await ragService.query(query, userId, options);
    
    if (!response) {
      throw createError('RAG query failed', 500, 'RAG_FAILED');
    }

    res.json({ success: true, data: response });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// POST /rag/similar - Find similar documents
const similarSchema = z.object({
  query: z.string().min(1).max(2000),
  userId: z.string().uuid(),
  limit: z.number().int().min(1).max(20).optional(),
});

router.post('/similar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query, userId, limit } = similarSchema.parse(req.body);
    
    const sources = await ragService.findSimilar(query, userId, limit);
    
    if (!sources) {
      throw createError('Similar search failed', 500, 'SEARCH_FAILED');
    }

    res.json({ success: true, data: { sources } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// POST /rag/chat - AI Chat with RAG
const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })),
  userId: z.string().uuid(),
  options: z.object({
    enableRAG: z.boolean().optional(),
    maxSources: z.number().int().min(1).max(10).optional(),
    collections: z.array(z.string().uuid()).optional(),
  }).optional(),
});

router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { messages, userId, options } = chatSchema.parse(req.body);
    
    const response = await ragService.chat(messages, userId, options);
    
    if (!response) {
      throw createError('Chat failed', 500, 'CHAT_FAILED');
    }

    res.json({ success: true, data: response });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// POST /rag/chat/stream - Streaming chat (SSE)
router.post('/chat/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { messages, userId, options } = chatSchema.parse(req.body);
    
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    for await (const chunk of ragService.chatStream(messages, userId, options)) {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

export { router as ragRoutes };
