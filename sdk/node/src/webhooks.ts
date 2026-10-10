import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies the `X-OmniSwitch-Signature` header OmniSwitch signs its own
 * outbound webhooks with (dispute/subscription/AML-review/sanctions-
 * screening notifications) — `t=<unix seconds>,v1=<hex HMAC-SHA256
 * digest>` over `${timestamp}.${rawBody}`, keyed by *your* merchant HMAC
 * secret (the same one `X-Signature` request signing uses — see
 * `signRequest()`). This is the scheme
 * `src/shared/utils/notification-delivery.util.ts`'s
 * `signOmniSwitchPayload()` produces server-side; this function is its
 * verify-side mirror, same as every inbound webhook guard in this
 * codebase (`StripeWebhookGuard`, `KycWebhookGuard`, ...) does for its
 * own signature scheme.
 *
 * `rawBody` must be the exact bytes received on the wire — verifying
 * against `JSON.stringify(JSON.parse(rawBody))` can silently fail for
 * payloads whose key order or number formatting changes on
 * parse-then-restringify, the identical trap `HmacSignatureGuard`'s own
 * docblock warns about for inbound requests.
 *
 * Returns `false` for a malformed header, an expired timestamp, or a
 * mismatched signature — never throws, so a caller can respond `401` on
 * a plain falsy check without a try/catch.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined | null,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split('=');
    if (key && value) acc[key] = value;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const providedSignature = parts['v1'];
  if (!timestamp || !providedSignature) return false;

  const requestTime = parseInt(timestamp, 10) * 1000;
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > toleranceSeconds * 1000) {
    return false;
  }

  const expectedSignature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  try {
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const providedBuffer = Buffer.from(providedSignature, 'hex');
    return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
  } catch {
    return false;
  }
}
