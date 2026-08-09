import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Reflector } from '@nestjs/core';
import { MerchantService } from '../../modules/merchant/merchant.service';
import { VaultTransitService } from '../vault/vault-transit.service';
import { UserRole } from '../decorators/roles.decorator';

export const SKIP_HMAC_KEY = 'skipHmac';

/**
 * HMAC-SHA256 Signature Verification Guard
 * Validates request payload integrity using HMAC-SHA256.
 *
 * Expected headers:
 * - X-Signature: HMAC-SHA256 hex digest of request body
 * - X-Timestamp: Unix timestamp (prevents replay attacks, max 5 min drift)
 * - X-Merchant-Id: Merchant identifier for key lookup
 */
@Injectable()
export class HmacSignatureGuard implements CanActivate {
  private readonly logger = new Logger(HmacSignatureGuard.name);
  private readonly maxTimestampDriftMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    private readonly merchantService: MerchantService,
    private readonly vaultTransit: VaultTransitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if HMAC verification is skipped for this route
    const skipHmac = this.reflector.getAllAndOverride<boolean>(SKIP_HMAC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipHmac) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // An agent acting under a Delegation has no business holding the
    // merchant's own HMAC secret — handing it out would defeat the whole
    // point of a narrow, revocable credential (see delegation.aggregate.ts
    // and docs/business-domain/future-directions.md#agentic-payments).
    // This guard runs after JwtAuthGuard/RolesGuard at the controller level
    // (see PaymentController's @UseGuards order), so request.user is
    // already populated. For this MVP, the delegation JWT's own possession
    // plus its real-time jti-revocation check (JwtStrategy) is the
    // authenticity proof for an agent-initiated request; a per-request
    // agent signing scheme is real, documented future work, not something
    // silently skipped by accident.
    if (request.user?.roles?.includes(UserRole.AGENT)) {
      return true;
    }

    const signature = request.headers['x-signature'];
    const timestamp = request.headers['x-timestamp'];
    const merchantId = request.headers['x-merchant-id'];

    if (!signature || !timestamp || !merchantId) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Missing HMAC signature headers',
        code: 'MISSING_SIGNATURE_HEADERS',
        required: ['X-Signature', 'X-Timestamp', 'X-Merchant-Id'],
      });
    }

    // Validate timestamp to prevent replay attacks
    const requestTime = parseInt(timestamp, 10) * 1000;
    if (!Number.isFinite(requestTime)) {
      // parseInt('garbage') -> NaN, and NaN comparisons are always false, so a
      // non-numeric X-Timestamp would otherwise silently skip the drift check.
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'X-Timestamp must be a Unix timestamp (seconds)',
        code: 'INVALID_TIMESTAMP',
      });
    }

    const now = Date.now();
    const drift = Math.abs(now - requestTime);

    if (drift > this.maxTimestampDriftMs) {
      this.logger.warn(`HMAC timestamp drift too large: ${drift}ms for merchant ${merchantId}`);
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Request timestamp is too old or too far in the future',
        code: 'TIMESTAMP_DRIFT_EXCEEDED',
        maxDriftSeconds: this.maxTimestampDriftMs / 1000,
      });
    }

    // Get merchant's HMAC secret
    const hmacSecret = await this.getMerchantHmacSecret(merchantId);
    if (!hmacSecret) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unknown merchant',
        code: 'UNKNOWN_MERCHANT',
      });
    }
    if (hmacSecret.length < 16) {
      // A short/placeholder secret (e.g. a "CHANGE_ME" value left over from a
      // template) is brute-forceable; treat it as misconfiguration and fail
      // closed rather than verifying signatures against a weak key.
      this.logger.error(`HMAC secret for merchant ${merchantId} is shorter than 16 chars — treating as misconfigured`);
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Merchant HMAC key is misconfigured',
        code: 'HMAC_KEY_MISCONFIGURED',
      });
    }

    // Build the signed payload: timestamp + method + path + body.
    // Uses the untouched wire bytes captured via NestFactory's `rawBody: true`
    // option (see main.ts) — signing a re-serialized JSON.stringify(req.body)
    // would not actually validate what the client sent (key order, whitespace,
    // number formatting, etc. can all change during parse-then-restringify).
    const rawBody: Buffer | undefined = request.rawBody;
    const body = rawBody ? rawBody.toString('utf8') : '';
    const method = request.method.toUpperCase();
    const path = request.originalUrl || request.url;
    const signedPayload = `${timestamp}.${method}.${path}.${body}`;

    // Compute expected signature
    const expectedSignature = createHmac('sha256', hmacSecret)
      .update(signedPayload)
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks
    try {
      const sigBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      if (sigBuffer.length !== expectedBuffer.length) {
        throw new Error('Signature length mismatch');
      }

      if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
        throw new Error('Signature mismatch');
      }
    } catch {
      this.logger.warn(`HMAC signature verification failed for merchant ${merchantId}`);
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Invalid request signature',
        code: 'INVALID_SIGNATURE',
      });
    }

    this.logger.debug(`HMAC signature verified for merchant ${merchantId}`);
    return true;
  }

  private async getMerchantHmacSecret(merchantId: string): Promise<string | null> {
    // Primary source of truth: the merchant record (rotatable without a
    // redeploy — see MerchantAdminController's secret-rotation endpoint).
    // The column holds ciphertext (Vault Transit) — decrypt before using it
    // to compute an HMAC. See docs/technical/secret-management.md.
    const merchant = await this.merchantService.findByMerchantId(merchantId);
    if (merchant?.hmacSecretCiphertext) {
      return this.vaultTransit.decrypt(merchant.hmacSecretCiphertext);
    }

    // Fall back to a per-merchant env var, then the global HMAC secret, for
    // merchants that predate the DB-backed credential store (dev convenience
    // / migration path). Returns null — not a hardcoded default — so a
    // missing configuration fails closed via the UNKNOWN_MERCHANT check
    // above instead of silently accepting a guessable secret.
    const envSecret = this.configService.get<string>(`HMAC_SECRET_${merchantId.toUpperCase()}`);
    if (envSecret) return envSecret;

    return this.configService.get<string>('HMAC_SECRET') ?? null;
  }
}
