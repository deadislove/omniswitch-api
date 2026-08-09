import { createHmac } from 'crypto';

/** Signs a request body the same way HmacSignatureGuard verifies it. */
export function signHmacRequest(
  hmacSecret: string,
  method: string,
  path: string,
  body: string,
): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
  const signature = createHmac('sha256', hmacSecret).update(signedPayload).digest('hex');
  return { signature, timestamp };
}

/** Signs a Stripe webhook body the same way StripeWebhookGuard verifies it. */
export function signStripeWebhook(webhookSecret: string, rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${rawBody}`;
  const signature = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

interface AdyenNotificationFields {
  pspReference: string;
  originalReference?: string;
  merchantAccountCode: string;
  merchantReference: string;
  amountValue: number;
  amountCurrency: string;
  eventCode: string;
  success: string;
}

/** Signs an Adyen notification item the same way AdyenWebhookGuard verifies it. */
export function signAdyenNotification(hmacKeyHex: string, fields: AdyenNotificationFields): string {
  const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const dataToSign = [
    fields.pspReference,
    fields.originalReference ?? '',
    fields.merchantAccountCode,
    fields.merchantReference,
    String(fields.amountValue),
    fields.amountCurrency,
    fields.eventCode,
    fields.success,
  ]
    .map((v) => escape(String(v)))
    .join(':');

  return createHmac('sha256', Buffer.from(hmacKeyHex, 'hex')).update(dataToSign, 'utf8').digest('base64');
}
