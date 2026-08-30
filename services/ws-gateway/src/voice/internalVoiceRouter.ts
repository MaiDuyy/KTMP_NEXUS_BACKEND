import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { VoicePipelineContextRequest, VoicePipelineEvent } from '@ott/shared';
import type { VoiceTurnController } from './voiceTurnController.js';

export interface VoiceMetricsEndpoint {
  contentType: string;
  render(): Promise<string>;
}

export const VOICE_INTERNAL_SERVICE_KEY_HEADER = 'x-voice-internal-service-key';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function authorized(provided: unknown, expected: string | null): boolean {
  if (!expected || typeof provided !== 'string' || provided.length === 0) {
    return false;
  }
  return timingSafeEqual(digest(provided), digest(expected));
}

export function createVoiceInternalRouter(
  controller: VoiceTurnController,
  serviceKey: string | null,
  metrics?: VoiceMetricsEndpoint,
): Router {
  const router = Router();
  router.get('/metrics', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!metrics) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (!authorized(request.headers[VOICE_INTERNAL_SERVICE_KEY_HEADER], serviceKey)) {
      response.status(401).json({ code: 'VOICE_INTERNAL_UNAUTHORIZED' });
      return;
    }
    response.status(200).type(metrics.contentType).send(await metrics.render());
  });

  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!authorized(request.headers[VOICE_INTERNAL_SERVICE_KEY_HEADER], serviceKey)) {
      response.status(401).json({ code: 'VOICE_INTERNAL_UNAUTHORIZED' });
      return;
    }
    next();
  });

  router.post('/turns/context', async (request, response) => {
    try {
      const context = await controller.getPipelineContext(request.body as VoicePipelineContextRequest);
      if (!context) {
        response.status(409).json({ code: 'VOICE_TURN_EXPIRED' });
        return;
      }
      response.status(200).json(context);
    } catch {
      response.status(500).json({ code: 'VOICE_INTERNAL_ERROR' });
    }
  });

  router.post('/turns/events', async (request, response) => {
    try {
      const accepted = await controller.handlePipelineEvent(request.body as VoicePipelineEvent);
      if (!accepted) {
        response.status(409).json({ code: 'VOICE_TURN_EXPIRED' });
        return;
      }
      response.status(202).json({ status: 'accepted' });
    } catch {
      response.status(500).json({ code: 'VOICE_INTERNAL_ERROR' });
    }
  });

  return router;
}
