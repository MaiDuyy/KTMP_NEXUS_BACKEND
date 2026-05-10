// services/knowledge-service/src/subscribers/ai.subscriber.ts
import { subscribe, publishEvent, EventSubjects } from '../lib/nats.js';
import { ragService } from '../services/rag.service.js';
import { logger } from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';

const AI_USER_ID = '00000000-0000-0000-0000-000000000000'; // System AI user ID

export function startAISubscriber() {
  subscribe('ai.request', async (data: any) => {
    const { messageId, chatId, senderId, content } = data;
    
    logger.info({ chatId, senderId, content: content?.slice(0, 50) }, 'Processing AI request');

    try {
      // 1. Execute RAG query
      const ragResponse = await ragService.query(content, senderId, {
        maxResults: 5,
        minScore: 0.6,
      });

      if (!ragResponse) {
        logger.warn({ chatId }, 'RAG query returned no response');
        return;
      }

      // 2. Format response (add sources if available)
      let answer = ragResponse.answer;
      if (ragResponse.sources && ragResponse.sources.length > 0) {
        const sourcesText = ragResponse.sources
          .map((s, i) => `[${i + 1}] ${s.documentTitle}`)
          .join(', ');
        answer += `\n\n_Nguồn: ${sourcesText}_`;
      }

      // 3. Publish AI response as a new message
      // Note: In a real system, you might want to call chat-service via gRPC/HTTP 
      // but here we publish an event that ws-gateway can broadcast
      await publishEvent(EventSubjects.MESSAGE_CREATED, {
        id: uuidv4(),
        chatId,
        senderId: AI_USER_ID,
        sender: {
          id: AI_USER_ID,
          name: 'AI Assistant',
          avatar: 'https://cdn-icons-png.flaticon.com/512/4712/4712035.png', // AI Avatar
        },
        content: answer,
        type: 'text',
        time: new Date().toISOString(),
        replyTo: { id: messageId }, // Reply to the triggering message
        reactions: [],
        pin: false,
      });

      logger.info({ chatId }, 'AI response published');
    } catch (error) {
      logger.error({ error, chatId }, 'Failed to process AI request');
    }
  });

  logger.info('AI Subscriber started');
}
