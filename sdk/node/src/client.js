"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmniSwitchClient = void 0;
const crypto_1 = require("crypto");
const signing_1 = require("./signing");
const errors_1 = require("./errors");
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_SKEW_MS = 30_000;
class OmniSwitchClient {
    constructor(options) {
        this.options = options;
        this.token = null;
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.fetchImpl = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    async charge(params, opts = {}) {
        return this.request('POST', '/payments/charge', params, { signed: true, ...opts });
    }
    async getPayment(paymentId) {
        return this.request('GET', `/payments/${encodeURIComponent(paymentId)}`);
    }
    async refund(paymentId, params = {}, opts = {}) {
        return this.request('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, params, {
            signed: true,
            ...opts,
        });
    }
    async capture(paymentId, params = {}, opts = {}) {
        return this.request('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, params, {
            signed: true,
            ...opts,
        });
    }
    async cancel(paymentId, opts = {}) {
        return this.request('POST', `/payments/${encodeURIComponent(paymentId)}/cancel`, {}, {
            signed: true,
            ...opts,
        });
    }
    async authenticate() {
        if (this.token && this.token.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
            return this.token.accessToken;
        }
        const response = await this.fetchWithTimeout(`${this.baseUrl}/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKeyId: this.options.apiKeyId, apiKeySecret: this.options.apiKeySecret }),
        });
        if (!response.ok) {
            throw await errors_1.OmniSwitchApiError.fromResponse(response);
        }
        const body = (await response.json());
        if (body.mfaRequired) {
            throw new errors_1.OmniSwitchApiError(401, 'This merchant has MFA enabled — this SDK does not support the MFA challenge flow. Use a credential without MFA enabled for server-side integrations.', 'MFA_NOT_SUPPORTED');
        }
        this.token = { accessToken: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 };
        return this.token.accessToken;
    }
    async request(method, path, body, opts = {}, isRetry = false) {
        const accessToken = await this.authenticate();
        const bodyStr = body !== undefined ? JSON.stringify(body) : '';
        const fullPath = `/api/v1${path}`;
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };
        if (opts.signed) {
            const { signature, timestamp } = (0, signing_1.signRequest)(this.options.hmacSecret, method, fullPath, bodyStr);
            headers['X-Signature'] = signature;
            headers['X-Timestamp'] = timestamp;
            headers['X-Merchant-Id'] = this.options.merchantId;
            headers['Idempotency-Key'] = opts.idempotencyKey ?? (0, crypto_1.randomUUID)();
        }
        const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
            method,
            headers,
            ...(body !== undefined ? { body: bodyStr } : {}),
        });
        if (response.status === 401 && this.token && !isRetry) {
            this.token = null;
            return this.request(method, path, body, opts, true);
        }
        if (!response.ok) {
            throw await errors_1.OmniSwitchApiError.fromResponse(response);
        }
        return (await response.json());
    }
    async fetchWithTimeout(url, init) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            return await this.fetchImpl(url, { ...init, signal: controller.signal });
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.OmniSwitchClient = OmniSwitchClient;
//# sourceMappingURL=client.js.map