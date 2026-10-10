import { createHmac } from 'crypto';
import { verifyWebhookSignature } from '../src/webhooks';

function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('verifyWebhookSignature', () => {
  const secret = 'a'.repeat(64);
  const body = JSON.stringify({ event: 'dispute.created', paymentId: 'pay_1' });

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyWebhookSignature(secret, body, sign(secret, body))).toBe(true);
  });

  it('rejects a payload signed with the wrong secret', () => {
    expect(verifyWebhookSignature(secret, body, sign('b'.repeat(64), body))).toBe(false);
  });

  it('rejects a mutated body against a signature computed for the original', () => {
    const header = sign(secret, body);
    expect(verifyWebhookSignature(secret, body + 'tampered', header)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
    expect(verifyWebhookSignature(secret, body, '')).toBe(false);
  });

  it('rejects a malformed header (missing t= or v1=)', () => {
    expect(verifyWebhookSignature(secret, body, 'v1=deadbeef')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 't=1700000000')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'garbage')).toBe(false);
  });

  it('rejects a timestamp outside the tolerance window', () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes old
    const header = sign(secret, body, staleTimestamp);
    expect(verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it('accepts a custom tolerance window', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute old
    const header = sign(secret, body, timestamp);
    expect(verifyWebhookSignature(secret, body, header, 30)).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, 120)).toBe(true);
  });

  it('rejects a non-hex v1 value without throwing', () => {
    expect(() => verifyWebhookSignature(secret, body, 't=1700000000,v1=not-hex!!')).not.toThrow();
    expect(verifyWebhookSignature(secret, body, 't=1700000000,v1=not-hex!!')).toBe(false);
  });
});
