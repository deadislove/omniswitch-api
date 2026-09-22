import { createHmac } from 'crypto';

/**
 * The "actually send it" mechanics shared by every outbound notification
 * channel across every event family this platform has (dispute,
 * subscription, AML review, sanctions-screening — each email/Slack/
 * webhook) — a plain JSON POST with a timeout, and the HMAC scheme
 * `WebhookDisputeNotificationAdapter` originated. Lives in `shared/`,
 * not `payment/adapters/notifications/` where it originated, because
 * sanctions-screening notifications are dispatched from `MerchantModule`
 * — which `PaymentModule` depends on, never the reverse (see
 * `docs/technical/architecture.md`'s module graph) — so a module-graph-
 * respecting shared location, not a fourth copy of this fetch call, is
 * what let that family reuse it too.
 */

/** A thrown-on-non-ok Error, widened with the actual HTTP status when one was received at all — absent for a pure network failure/timeout, where there was never a response to read a status from. */
export interface NotificationDeliveryError extends Error {
  statusCode?: number;
}

/**
 * Returns the response's status on success — every existing caller
 * ignored the return value entirely before `WebhookDeliveryLogService`
 * needed it (see that service's own docblock), so widening this from
 * `Promise<void>` is backward compatible, not a behavior change for any
 * of them.
 */
export async function postJsonNotification(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const err: NotificationDeliveryError = new Error(`Notification POST to ${url} got HTTP ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }
  return { status: response.status };
}

/**
 * Same `${timestamp}.${rawBody}` HMAC-SHA256 scheme `StripeWebhookGuard`
 * verifies incoming PSP webhooks with, just outbound — returns the header
 * value directly (`t=<unix seconds>,v1=<hex digest>`) since every caller
 * sends it under the same `X-OmniSwitch-Signature` header name.
 */
export function signOmniSwitchPayload(secret: string, bodyStr: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${bodyStr}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}
