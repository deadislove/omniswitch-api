"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("../src/client");
const errors_1 = require("../src/errors");
function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}
function makeClient(fetchMock) {
    return new client_1.OmniSwitchClient({
        baseUrl: 'https://api.example.com/api/v1',
        apiKeyId: 'ak_test',
        apiKeySecret: 'sk_test',
        hmacSecret: 'h'.repeat(64),
        merchantId: 'merchant_acme',
        fetch: fetchMock,
    });
}
describe('OmniSwitchClient', () => {
    it('authenticates once, then reuses the cached token for a second call', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_1', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(200, { paymentId: 'pay_1', status: 'SUCCEEDED' }))
            .mockResolvedValueOnce(jsonResponse(200, { paymentId: 'pay_1', status: 'SUCCEEDED' }));
        const client = makeClient(fetchMock);
        await client.getPayment('pay_1');
        await client.getPayment('pay_1');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/api/v1/auth/token');
    });
    it('sends X-Signature/X-Timestamp/X-Merchant-Id/Idempotency-Key on a signed call (charge)', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_1', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(201, { paymentId: 'pay_1', status: 'SUCCEEDED', requiresAction: false, usedFallback: false }));
        const client = makeClient(fetchMock);
        await client.charge({ amount: 10, currency: 'USD' });
        const [, chargeCall] = fetchMock.mock.calls;
        const [url, init] = chargeCall;
        expect(url).toBe('https://api.example.com/api/v1/payments/charge');
        expect(init.headers['X-Signature']).toEqual(expect.any(String));
        expect(init.headers['X-Timestamp']).toEqual(expect.any(String));
        expect(init.headers['X-Merchant-Id']).toBe('merchant_acme');
        expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
        expect(init.headers['Authorization']).toBe('Bearer jwt_1');
    });
    it('does NOT sign a GET request (getPayment) — no X-Signature/Idempotency-Key headers', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_1', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(200, { paymentId: 'pay_1' }));
        const client = makeClient(fetchMock);
        await client.getPayment('pay_1');
        const [, getCall] = fetchMock.mock.calls;
        const [, init] = getCall;
        expect(init.headers['X-Signature']).toBeUndefined();
        expect(init.headers['Idempotency-Key']).toBeUndefined();
    });
    it('reuses a caller-supplied idempotencyKey across an explicit retry instead of generating a new one', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_1', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(201, { paymentId: 'pay_1' }));
        const client = makeClient(fetchMock);
        await client.charge({ amount: 10, currency: 'USD' }, { idempotencyKey: 'my-fixed-key' });
        const [, chargeCall] = fetchMock.mock.calls;
        expect(chargeCall[1].headers['Idempotency-Key']).toBe('my-fixed-key');
    });
    it('retries exactly once with a fresh token on a 401, then succeeds', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_1', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401, error: 'Invalid or expired token', code: 'INVALID_TOKEN' }))
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_2', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(200, { paymentId: 'pay_1' }));
        const client = makeClient(fetchMock);
        const result = await client.getPayment('pay_1');
        expect(result).toEqual({ paymentId: 'pay_1' });
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(fetchMock.mock.calls[3][1].headers['Authorization']).toBe('Bearer jwt_2');
    });
    it('throws OmniSwitchApiError with statusCode/code/error from the response body', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_1', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(422, {
            statusCode: 422,
            error: 'Charge of $50.00 USD exceeds this delegation\'s per-transaction limit',
            code: 'DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED',
        }));
        const client = makeClient(fetchMock);
        await expect(client.charge({ amount: 50, currency: 'USD' })).rejects.toMatchObject({
            statusCode: 422,
            code: 'DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED',
        });
    });
    it('throws a clear MFA_NOT_SUPPORTED error instead of silently returning a restricted token', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_pending', tokenType: 'Bearer', expiresIn: 300, mfaRequired: true }));
        const client = makeClient(fetchMock);
        const error = await client.getPayment('pay_1').catch((e) => e);
        expect(error).toBeInstanceOf(errors_1.OmniSwitchApiError);
        expect(error).toMatchObject({ code: 'MFA_NOT_SUPPORTED' });
    });
    it('refund/capture/cancel all sign and hit the expected paths', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt_1', tokenType: 'Bearer', expiresIn: 3600 }))
            .mockResolvedValueOnce(jsonResponse(200, { paymentId: 'pay_1', status: 'REFUNDED' }))
            .mockResolvedValueOnce(jsonResponse(200, { paymentId: 'pay_1', status: 'SUCCEEDED' }))
            .mockResolvedValueOnce(jsonResponse(200, { paymentId: 'pay_1', status: 'CANCELLED' }));
        const client = makeClient(fetchMock);
        await client.refund('pay_1', { amount: 5 });
        await client.capture('pay_1');
        await client.cancel('pay_1');
        expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/api/v1/payments/pay_1/refund');
        expect(fetchMock.mock.calls[2][0]).toBe('https://api.example.com/api/v1/payments/pay_1/capture');
        expect(fetchMock.mock.calls[3][0]).toBe('https://api.example.com/api/v1/payments/pay_1/cancel');
        for (const call of fetchMock.mock.calls.slice(1)) {
            expect(call[1].headers['X-Signature']).toEqual(expect.any(String));
        }
    });
});
//# sourceMappingURL=client.spec.js.map