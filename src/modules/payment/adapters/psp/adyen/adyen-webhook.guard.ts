import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface AdyenNotificationRequestItem {
  pspReference: string;
  originalReference?: string;
  merchantAccountCode: string;
  merchantReference: string;
  amount: { value: number; currency: string };
  eventCode: string;
  success: string;
  reason?: string;
  additionalData?: Record<string, string>;
}

/**
 * Adyen Webhook HMAC Guard
 * Verifies the per-item `additionalData.hmacSignature` per Adyen's documented
 * scheme: https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures/
 *
 * Unlike Stripe, Adyen signs specific field values (not the raw request
 * bytes) joined with ':', so JSON re-parsing doesn't invalidate the
 * signature — but each colon/backslash in a field value must be escaped
 * before joining, or the signature won't match.
 */
@Injectable()
export class AdyenWebhookGuard implements CanActivate {
  private readonly logger = new Logger(AdyenWebhookGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const hmacKeyHex = this.configService.get<string>('ADYEN_HMAC_KEY');
    if (!hmacKeyHex) {
      this.logger.error('ADYEN_HMAC_KEY is not configured — rejecting all Adyen webhooks');
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Webhook receiver is not configured',
        code: 'WEBHOOK_MISCONFIGURED',
      });
    }

    const items: Array<{ NotificationRequestItem: AdyenNotificationRequestItem }> =
      request.body?.notificationItems;
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Missing notificationItems',
        code: 'INVALID_PAYLOAD',
      });
    }

    const hmacKey = Buffer.from(hmacKeyHex, 'hex');

    for (const wrapper of items) {
      const item = wrapper?.NotificationRequestItem;
      const providedSignature = item?.additionalData?.hmacSignature;
      if (!item || !providedSignature) {
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Missing hmacSignature on notification item',
          code: 'MISSING_SIGNATURE',
        });
      }

      const dataToSign = this.buildSigningString(item);
      const expectedSignature = createHmac('sha256', hmacKey).update(dataToSign, 'utf8').digest('base64');

      try {
        const expectedBuffer = Buffer.from(expectedSignature, 'base64');
        const providedBuffer = Buffer.from(providedSignature, 'base64');
        if (
          expectedBuffer.length !== providedBuffer.length ||
          !timingSafeEqual(expectedBuffer, providedBuffer)
        ) {
          throw new Error('mismatch');
        }
      } catch {
        this.logger.warn(`Adyen webhook HMAC verification failed for pspReference=${item.pspReference}`);
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Invalid webhook signature',
          code: 'INVALID_SIGNATURE',
        });
      }
    }

    return true;
  }

  private buildSigningString(item: AdyenNotificationRequestItem): string {
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    const fields = [
      item.pspReference ?? '',
      item.originalReference ?? '',
      item.merchantAccountCode ?? '',
      item.merchantReference ?? '',
      String(item.amount?.value ?? ''),
      item.amount?.currency ?? '',
      item.eventCode ?? '',
      item.success ?? '',
    ];
    return fields.map((v) => escape(String(v))).join(':');
  }
}
