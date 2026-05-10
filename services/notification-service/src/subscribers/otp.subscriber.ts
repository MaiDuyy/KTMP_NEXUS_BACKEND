// services/notification-service/src/subscribers/otp.subscriber.ts
// OTP email event subscriber

import { subscribe, EventSubjects } from '../lib/nats.js';
import { emailService } from '../services/email.service.js';
import { logger } from '../lib/logger.js';
import type { OtpEmailPayload } from '../lib/events.js';

export function setupOtpSubscriber() {
  subscribe<OtpEmailPayload>(EventSubjects.OTP_SEND, async (data) => {
    logger.info({ email: data.email, type: data.type }, 'Received OTP send event');
    
    const success = await emailService.sendOtpEmail(data);
    
    if (!success) {
      logger.error({ email: data.email }, 'Failed to process OTP email event');
    }
  });

  logger.info('OTP email subscriber initialized');
}
