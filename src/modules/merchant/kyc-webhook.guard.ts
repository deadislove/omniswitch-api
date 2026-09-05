import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * KYC Webhook Signature Guard
 * Identical scheme to `StripeWebhookGuard`/`BankTransferWebhookGuard` —
 * deliberately, so a real KYC provider's webhook (Persona/Onfido) can be
 * verified the same way this codebase already verifies Stripe's:
 *
 *   signedPayload = `${timestamp}.${rawRequestBody}`
 *   expected = hex(HMAC-SHA256(KYC_WEBHOOK_SECRET, signedPayload))
 *
 * `X-KYC-Signature: t=<unix seconds>,v1=<hex digest>`.
 * `scripts/mock-psp/server.js`'s `/persona/kyc-applications` async
 * callback signs with this exact scheme (see `signKycCallback` there) so
 * the mock exercises the real verification path, not a bypassed one.
 */
@Injectable()
export class KycWebhookGuard implements CanActivate {
  private readonly logger = new Logger(KycWebhookGuard.name);
  private readonly toleranceSeconds = 5 * 60;

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-kyc-signature'];

    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Missing X-KYC-Signature header',
        code: 'MISSING_SIGNATURE',
      });
    }

    const secret = this.configService.get<string>('KYC_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('KYC_WEBHOOK_SECRET is not configured — rejecting all KYC webhooks');
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Webhook receiver is not configured',
        code: 'WEBHOOK_MISCONFIGURED',
      });
    }

    const rawBody: Buffer | undefined = request.rawBody;
    if (!rawBody) {
      throw new UnauthorizedException({ statusCode: 401, error: 'Missing raw request body', code: 'MISSING_RAW_BODY' });
    }

    const parts = header.split(',').reduce<Record<string, string>>((acc, part) => {
      const [key, value] = part.split('=');
      if (key && value) acc[key] = value;
      return acc;
    }, {});

    const timestamp = parts['t'];
    const providedSignature = parts['v1'];
    if (!timestamp || !providedSignature) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Malformed X-KYC-Signature header',
        code: 'INVALID_SIGNATURE_HEADER',
      });
    }

    const requestTime = parseInt(timestamp, 10) * 1000;
    if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > this.toleranceSeconds * 1000) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Webhook timestamp outside tolerance window',
        code: 'TIMESTAMP_DRIFT_EXCEEDED',
      });
    }

    const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
    const expectedSignature = createHmac('sha256', secret).update(signedPayload).digest('hex');

    try {
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');
      const providedBuffer = Buffer.from(providedSignature, 'hex');
      if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
        throw new Error('mismatch');
      }
    } catch {
      this.logger.warn('KYC webhook signature verification failed');
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Invalid webhook signature',
        code: 'INVALID_SIGNATURE',
      });
    }

    return true;
  }
}
