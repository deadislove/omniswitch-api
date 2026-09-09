import { createHmac } from 'crypto';

/**
 * The "actually send it" mechanics shared by every outbound notification
 * channel across both event families this platform has (dispute
 * email/Slack/webhook, subscription email/Slack/webhook) — a plain JSON
 * POST with a timeout, and the HMAC scheme `WebhookDisputeNotification-
 * Adapter` originated. Kept here instead of duplicated per-family so a
 * future third family reuses the same two functions rather than a fourth
 * copy of this fetch call.
 */

export async function postJsonNotification(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Notification POST to ${url} got HTTP ${response.status}`);
  }
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
