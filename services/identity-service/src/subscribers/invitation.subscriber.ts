// services/identity-service/src/subscribers/invitation.subscriber.ts

import { JSONCodec } from 'nats';
import { getNatsConnection, EventSubjects } from '../lib/nats.js';
import { authService } from '../services/auth.service.js';
import { logger } from '../lib/logger.js';

const jsonCodec = JSONCodec();

export const startInvitationSubscriber = async () => {
  const nats = getNatsConnection();
  if (!nats) {
    logger.error('NATS connection not available for invitation subscriber');
    return;
  }

  const sub = nats.subscribe(EventSubjects.INVITATION_ACCEPTED);
  
  (async () => {
    for await (const msg of sub) {
      try {
        const { payload: data } = jsonCodec.decode(msg.data) as any;
        logger.info({ invitationId: data.invitationId, email: data.email }, 'Processing invitation.accepted');
        
        await authService.createAccountFromInvitation({
          email: data.email,
          name: data.name,
          password: data.password,
          gender: data.gender,
          role: data.role,
          workspaceId: data.workspaceId,
          orgId: data.orgId,
          channelIds: data.channelIds
        });
        
      } catch (error) {
        logger.error({ error }, 'Error processing invitation.accepted event');
      }
    }
  })();
  
  logger.info('Invitation subscriber started');
};
