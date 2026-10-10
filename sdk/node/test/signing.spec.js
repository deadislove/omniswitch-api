"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const signing_1 = require("../src/signing");
describe('signRequest', () => {
    it('produces the exact signature HmacSignatureGuard verifies: HMAC-SHA256(secret, `${timestamp}.${method}.${path}.${body}`)', () => {
        const secret = 'a'.repeat(64);
        const { signature, timestamp } = (0, signing_1.signRequest)(secret, 'post', '/api/v1/payments/charge', '{"amount":10}');
        const expected = (0, crypto_1.createHmac)('sha256', secret)
            .update(`${timestamp}.POST./api/v1/payments/charge.{"amount":10}`)
            .digest('hex');
        expect(signature).toBe(expected);
    });
    it('uppercases the method regardless of caller casing', () => {
        const secret = 'a'.repeat(64);
        const lower = (0, signing_1.signRequest)(secret, 'get', '/api/v1/payments/pay_1', '');
        const upper = (0, signing_1.signRequest)(secret, 'GET', '/api/v1/payments/pay_1', '');
        const recomputed = (0, crypto_1.createHmac)('sha256', secret)
            .update(`${lower.timestamp}.GET./api/v1/payments/pay_1.`)
            .digest('hex');
        expect(lower.signature).toBe(recomputed);
        expect(typeof upper.signature).toBe('string');
    });
    it('returns a Unix-seconds timestamp as a string', () => {
        const { timestamp } = (0, signing_1.signRequest)('secret', 'POST', '/api/v1/payments/charge', '{}');
        expect(timestamp).toMatch(/^\d+$/);
        expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(5);
    });
    it('produces a different signature for a different body — the signature covers the exact wire bytes', () => {
        const secret = 'a'.repeat(64);
        const a = (0, signing_1.signRequest)(secret, 'POST', '/api/v1/payments/charge', '{"amount":10}');
        const b = (0, signing_1.signRequest)(secret, 'POST', '/api/v1/payments/charge', '{"amount":20}');
        expect(a.signature).not.toBe(b.signature);
    });
});
//# sourceMappingURL=signing.spec.js.map