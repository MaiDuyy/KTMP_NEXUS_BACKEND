import crypto from 'crypto';

/**
 * Creates an HMAC signature for internal service requests.
 * Connects x-user-id, x-user-role, and potentially other fields into a secured string.
 */
export function createInternalSignature(
  secret: string,
  payload: {
    userId?: string;
    role?: string;
    roles?: string; // stringified JSON
    roleLevel?: string;
  }
): string {
  // Ordered array of values to ensure consistency
  const dataString = [
    payload.userId || 'anonymous',
    payload.role || 'GUEST',
    payload.roles || '[]',
    payload.roleLevel || '999',
  ].join('|');

  return crypto
    .createHmac('sha256', secret)
    .update(dataString)
    .digest('hex');
}

/**
 * Verifies the HMAC signature from an internal request.
 */
export function verifyInternalSignature(
  secret: string,
  signature: string,
  payload: {
    userId?: string;
    role?: string;
    roles?: string;
    roleLevel?: string;
  }
): boolean {
  if (!signature) return false;
  const expectedSig = createInternalSignature(secret, payload);
  
  // Use crypto.timingSafeEqual to prevent timing attacks
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (error) {
    return false;
  }
}
