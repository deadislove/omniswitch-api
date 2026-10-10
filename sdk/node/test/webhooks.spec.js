"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const webhooks_1 = require("../src/webhooks");
function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
    const signature = (0, crypto_1.createHmac)('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
}
describe('verifyWebhookSignature', () => {
    const secret = 'a'.repeat(64);
    const body = JSON.stringify({ event: 'dispute.created', paymentId: 'pay_1' });
    it('accepts a correctly signed, fresh payload', () => {
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, sign(secret, body))).toBe(true);
    });
    it('rejects a payload signed with the wrong secret', () => {
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, sign('b'.repeat(64), body))).toBe(false);
    });
    it('rejects a mutated body against a signature computed for the original', () => {
        const header = sign(secret, body);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body + 'tampered', header)).toBe(false);
    });
    it('rejects a missing signature header', () => {
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, undefined)).toBe(false);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, null)).toBe(false);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, '')).toBe(false);
    });
    it('rejects a malformed header (missing t= or v1=)', () => {
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, 'v1=deadbeef')).toBe(false);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, 't=1700000000')).toBe(false);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, 'garbage')).toBe(false);
    });
    it('rejects a timestamp outside the tolerance window', () => {
        const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60;
        const header = sign(secret, body, staleTimestamp);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, header)).toBe(false);
    });
    it('accepts a custom tolerance window', () => {
        const timestamp = Math.floor(Date.now() / 1000) - 60;
        const header = sign(secret, body, timestamp);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, header, 30)).toBe(false);
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, header, 120)).toBe(true);
    });
    it('rejects a non-hex v1 value without throwing', () => {
        expect(() => (0, webhooks_1.verifyWebhookSignature)(secret, body, 't=1700000000,v1=not-hex!!')).not.toThrow();
        expect((0, webhooks_1.verifyWebhookSignature)(secret, body, 't=1700000000,v1=not-hex!!')).toBe(false);
    });
});
//# sourceMappingURL=webhooks.spec.js.map