import { createHmac } from 'crypto';

/**
 * Computes the `X-Signature`/`X-Timestamp` pair `HmacSignatureGuard`
 * verifies — `${timestamp}.${method}.${path}.${rawBody}`, HMAC-SHA256,
 * hex digest (see docs/guide/api/README.md#hmac-request-signing).
 * `path` must be the exact request path the server sees, including the
 * `/api/v1` prefix and query string if any — the guard signs
 * `request.originalUrl`, not a normalized or query-stripped version.
 * `body` must be the *exact* bytes sent on the wire (this SDK always
 * signs the same JSON string it then sends, never a value re-serialized
 * afterward — see `HmacSignatureGuard`'s own docblock for why
 * re-serialization would silently break signatures for some payloads).
 */
export function signRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return { signature, timestamp };
}
