import { randomUUID } from 'crypto';
import { signRequest } from './signing';
import { OmniSwitchApiError } from './errors';
import {
  OmniSwitchClientOptions,
  ChargeParams,
  ChargeResponse,
  PaymentDetail,
  RefundParams,
  RefundResponse,
  CaptureParams,
  CaptureResponse,
  CancelResponse,
  IdempotentCallOptions,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
// Re-authenticate this far before the token's own expiresIn elapses,
// rather than waiting for a 401 — avoids paying an extra round trip on
// almost every request near the token's natural expiry.
const TOKEN_REFRESH_SKEW_MS = 30_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * OmniSwitch Node/TypeScript client.
 *
 * Handles the three things an integrator most reliably gets wrong doing
 * this by hand: HMAC request signing (`X-Signature`/`X-Timestamp`/
 * `X-Merchant-Id`, `signRequest()`), `Idempotency-Key` generation/reuse,
 * and — via the standalone `verifyWebhookSignature()` export, not this
 * class — outbound webhook signature verification. Auth
 * (`POST /auth/token`) is also managed transparently: the first call
 * obtains a JWT, later calls reuse it until shortly before its 1-hour
 * expiry, then re-authenticate automatically.
 *
 * Deliberately merchant-credential-only in this first cut — an
 * AGENT-delegation client (its own signing key, no `X-Merchant-Id`,
 * `POST /delegations`'s own token instead of `POST /auth/token`) is real
 * future scope this class doesn't cover yet, not an oversight; see
 * docs/guide/api/agentic-payments.md for that shape if you need it today.
 */
export class OmniSwitchClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private token: CachedToken | null = null;

  constructor(private readonly options: OmniSwitchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async charge(params: ChargeParams, opts: IdempotentCallOptions = {}): Promise<ChargeResponse> {
    return this.request<ChargeResponse>('POST', '/payments/charge', params, { signed: true, ...opts });
  }

  async getPayment(paymentId: string): Promise<PaymentDetail> {
    return this.request<PaymentDetail>('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  async refund(
    paymentId: string,
    params: RefundParams = {},
    opts: IdempotentCallOptions = {},
  ): Promise<RefundResponse> {
    return this.request<RefundResponse>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, params, {
      signed: true,
      ...opts,
    });
  }

  async capture(
    paymentId: string,
    params: CaptureParams = {},
    opts: IdempotentCallOptions = {},
  ): Promise<CaptureResponse> {
    return this.request<CaptureResponse>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, params, {
      signed: true,
      ...opts,
    });
  }

  async cancel(paymentId: string, opts: IdempotentCallOptions = {}): Promise<CancelResponse> {
    return this.request<CancelResponse>('POST', `/payments/${encodeURIComponent(paymentId)}/cancel`, {}, {
      signed: true,
      ...opts,
    });
  }

  /**
   * Obtains (or reuses) a JWT via `POST /auth/token`. Public so a caller
   * can pre-warm it or check credentials without making a payments call
   * — every other method calls this internally as needed.
   */
  async authenticate(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return this.token.accessToken;
    }

    const response = await this.fetchWithTimeout(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKeyId: this.options.apiKeyId, apiKeySecret: this.options.apiKeySecret }),
    });

    if (!response.ok) {
      throw await OmniSwitchApiError.fromResponse(response);
    }

    const body = (await response.json()) as { accessToken: string; expiresIn: number; mfaRequired?: boolean };
    if (body.mfaRequired) {
      // A pending, MFA-restricted token — this SDK is for server-side
      // integrations authenticating with an API key/secret pair, which
      // shouldn't have MFA enabled on that credential in the first place
      // (MFA guards the human dashboard login path). Surfacing this as a
      // clear error is more useful than silently returning a token that
      // every subsequent call would then get rejected with 403 for.
      throw new OmniSwitchApiError(
        401,
        'This merchant has MFA enabled — this SDK does not support the MFA challenge flow. Use a credential without MFA enabled for server-side integrations.',
        'MFA_NOT_SUPPORTED',
      );
    }

    this.token = { accessToken: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 };
    return this.token.accessToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { signed?: boolean; idempotencyKey?: string } = {},
    isRetry = false,
  ): Promise<T> {
    const accessToken = await this.authenticate();
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    const fullPath = `/api/v1${path}`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };

    if (opts.signed) {
      const { signature, timestamp } = signRequest(this.options.hmacSecret, method, fullPath, bodyStr);
      headers['X-Signature'] = signature;
      headers['X-Timestamp'] = timestamp;
      headers['X-Merchant-Id'] = this.options.merchantId;
      // Generate a fresh UUID v4 per logical call unless the caller is
      // deliberately retrying the same one (see IdempotentCallOptions'
      // own docblock — reuse the key across attempts of the *same*
      // operation, not once per HTTP attempt automatically here: this
      // SDK doesn't retry on its own, so "per call to this method" and
      // "per logical operation" already coincide for a single call).
      headers['Idempotency-Key'] = opts.idempotencyKey ?? randomUUID();
    }

    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: bodyStr } : {}),
    });

    if (response.status === 401 && this.token && !isRetry) {
      // The cached token may have been revoked server-side (rotation,
      // deactivation) even though it hasn't hit its own expiry yet —
      // exactly one retry with a forced re-authentication, guarded by
      // `isRetry` so a resource endpoint that 401s even against a freshly
      // issued token can't recurse unboundedly.
      this.token = null;
      return this.request<T>(method, path, body, opts, true);
    }

    if (!response.ok) {
      throw await OmniSwitchApiError.fromResponse(response);
    }

    return (await response.json()) as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
