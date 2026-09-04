import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Reflector } from '@nestjs/core';
import { MerchantService } from '../../modules/merchant/merchant.service';
import { DelegationPort } from '../../modules/payment/ports/outbound/delegation.port';
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
 * - X-Merchant-Id: Merchant identifier for key lookup (merchant callers only — see the AGENT branch below)
 */
@Injectable()
export class HmacSignatureGuard implements CanActivate {
  private readonly logger = new Logger(HmacSignatureGuard.name);
  private readonly maxTimestampDriftMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    private readonly merchantService: MerchantService,
    private readonly delegationPort: DelegationPort,
    private readonly vaultTransit: VaultTransitService,
  ) {
    // Same fail-fast bar as JWT_SECRET (jwt.strategy.ts) — HMAC_SECRET is
    // only ever *reached* as a fallback for merchants with no DB-backed
    // hmacSecretCiphertext (see getMerchantHmacSecret() below), but a
    // deployment that never trips that fallback would otherwise never
    // notice a missing or copy-pasted-placeholder value sitting there
    // unguarded until the day it actually got used. Guards are singletons
    // by default in Nest, so this constructor runs once at DI-container
    // build time — refusing to start here is the same "fail loud at boot,
    // not silently at request time" posture as JwtStrategy's check.
    const hmacSecret = configService.get<string>('HMAC_SECRET');
    if (!hmacSecret || hmacSecret.length < 32) {
      throw new Error(
        'HMAC_SECRET must be set to a random value of at least 32 characters. Refusing to start with a missing/weak secret.',
      );
    }
  }

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
    const isAgent = Boolean(request.user?.roles?.includes(UserRole.AGENT));

    const signature = request.headers['x-signature'];
    const timestamp = request.headers['x-timestamp'];
    // Only a merchant caller needs to send this — an agent's identity
    // (and therefore which key to verify against) comes from its JWT's
    // own delegationId claim, already authenticated by JwtAuthGuard
    // upstream, not from a client-supplied header.
    const merchantId = request.headers['x-merchant-id'];

    if (!signature || !timestamp || (!isAgent && !merchantId)) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Missing HMAC signature headers',
        code: 'MISSING_SIGNATURE_HEADERS',
        required: isAgent ? ['X-Signature', 'X-Timestamp'] : ['X-Signature', 'X-Timestamp', 'X-Merchant-Id'],
      });
    }

    this.assertTimestampFresh(timestamp, merchantId);

    const secret = isAgent
      ? await this.getAgentSigningKey(request.user.delegationId)
      : await this.getMerchantHmacSecret(merchantId);

    if (!secret) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: isAgent ? 'This delegation has no signing key — revoke it and create a new one' : 'Unknown merchant',
        code: isAgent ? 'DELEGATION_SIGNING_KEY_MISSING' : 'UNKNOWN_MERCHANT',
      });
    }
    if (secret.length < 32) {
      // Matches the constructor's HMAC_SECRET boot check — this is the
      // only enforcement point for the *per-merchant* env fallback
      // (HMAC_SECRET_<merchantId>), which can't be validated at boot the
      // way the single global HMAC_SECRET can (merchant IDs aren't known
      // ahead of time). A short/placeholder secret (e.g. a "CHANGE_ME"
      // value left over from a template) is brute-forceable; treat it as
      // misconfiguration and fail closed rather than verifying signatures
      // against a weak key. Real per-merchant secrets are always
      // randomBytes(32).toString('hex') (64 chars, see
      // MerchantService.rotateHmacSecret()) — same length agent signing
      // keys use (DelegationService.createDelegation()) — and never hit
      // this bar.
      this.logger.error(
        `HMAC secret for ${isAgent ? `delegation ${request.user.delegationId}` : `merchant ${merchantId}`} is shorter than 32 chars — treating as misconfigured`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Signing key is misconfigured',
        code: 'HMAC_KEY_MISCONFIGURED',
      });
    }

    this.assertSignatureMatches(
      request,
      signature,
      timestamp,
      secret,
      isAgent ? request.user.delegationId : merchantId,
    );

    return true;
  }

  private assertTimestampFresh(timestamp: string, identifierForLogging: string): void {
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
      this.logger.warn(`HMAC timestamp drift too large: ${drift}ms for ${identifierForLogging}`);
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Request timestamp is too old or too far in the future',
        code: 'TIMESTAMP_DRIFT_EXCEEDED',
        maxDriftSeconds: this.maxTimestampDriftMs / 1000,
      });
    }
  }

  /**
   * Shared by both the merchant and AGENT branches — the signing scheme
   * itself (timestamp + method + path + raw body, HMAC-SHA256, timing-safe
   * compare) doesn't change based on whose key is being checked, only
   * which key that is.
   */
  private assertSignatureMatches(
    request: any,
    signature: string,
    timestamp: string,
    secret: string,
    identifierForLogging: string,
  ): void {
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

    const expectedSignature = createHmac('sha256', secret).update(signedPayload).digest('hex');

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
      this.logger.warn(`HMAC signature verification failed for ${identifierForLogging}`);
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Invalid request signature',
        code: 'INVALID_SIGNATURE',
      });
    }

    this.logger.debug(`HMAC signature verified for ${identifierForLogging}`);
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

  /**
   * An agent acting under a Delegation never holds the merchant's own HMAC
   * secret — handing it out would defeat the whole point of a narrow,
   * revocable credential (see delegation.aggregate.ts and
   * docs/business-domain/future-directions.md#agentic-payments). Instead,
   * DelegationService.createDelegation() generates a signing key scoped to
   * this one delegation, encrypted the same way (Vault Transit) as a
   * merchant's own hmacSecretCiphertext. `delegationId` comes from the
   * caller's own JWT (`request.user.delegationId`, set by JwtStrategy),
   * not a client-supplied header — there's no reason to trust a header over
   * the token that was already cryptographically verified to get this far.
   *
   * Returns null for a delegation with no signing key at all — either one
   * created before this column existed, or (defensively) a delegationId
   * that doesn't resolve to a real row — fails closed via the
   * DELEGATION_SIGNING_KEY_MISSING check in canActivate() rather than
   * falling back to unconditionally trusting the token's own possession,
   * which is what this guard used to do for every AGENT request.
   */
  private async getAgentSigningKey(delegationId: string | undefined): Promise<string | null> {
    if (!delegationId) return null;
    const delegation = await this.delegationPort.findById(delegationId);
    if (!delegation?.signingKeyCiphertext) return null;
    return this.vaultTransit.decrypt(delegation.signingKeyCiphertext);
  }
}
