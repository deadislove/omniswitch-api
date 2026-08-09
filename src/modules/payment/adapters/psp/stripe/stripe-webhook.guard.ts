import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Stripe Webhook Signature Guard
 * Verifies the `Stripe-Signature` header per Stripe's documented scheme:
 * https://docs.stripe.com/webhooks#verify-manually
 *
 *   signedPayload = `${timestamp}.${rawRequestBody}`
 *   expected = hex(HMAC-SHA256(webhookSecret, signedPayload))
 *
 * Requires the exact wire bytes (NestFactory `rawBody: true`, see main.ts) —
 * verifying against a re-parsed/re-serialized body would not actually prove
 * the payload came from Stripe.
 */
@Injectable()
export class StripeWebhookGuard implements CanActivate {
  private readonly logger = new Logger(StripeWebhookGuard.name);
  private readonly toleranceSeconds = 5 * 60;

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['stripe-signature'];

    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Missing Stripe-Signature header',
        code: 'MISSING_SIGNATURE',
      });
    }

    const secret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      // Fail closed: without a configured secret there is nothing to verify
      // against, so every request (forged or not) would otherwise be trusted.
      this.logger.error('STRIPE_WEBHOOK_SECRET is not configured — rejecting all Stripe webhooks');
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Webhook receiver is not configured',
        code: 'WEBHOOK_MISCONFIGURED',
      });
    }

    const rawBody: Buffer | undefined = request.rawBody;
    if (!rawBody) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Missing raw request body',
        code: 'MISSING_RAW_BODY',
      });
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
        error: 'Malformed Stripe-Signature header',
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
      if (
        expectedBuffer.length !== providedBuffer.length ||
        !timingSafeEqual(expectedBuffer, providedBuffer)
      ) {
        throw new Error('mismatch');
      }
    } catch {
      this.logger.warn('Stripe webhook signature verification failed');
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Invalid webhook signature',
        code: 'INVALID_SIGNATURE',
      });
    }

    return true;
  }
}
