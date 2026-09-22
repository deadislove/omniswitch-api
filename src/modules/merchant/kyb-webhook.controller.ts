import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { KybWebhookGuard } from './kyb-webhook.guard';
import { MerchantService } from './merchant.service';
import { mapPersonaInquiryStatus } from './persona-inquiry-status';

/**
 * KYB Webhook Controller
 * Receives a real KYB provider's async review decision
 * (`PersonaKybProviderAdapter`'s counterpart) — same placement/reasoning
 * as `KycWebhookController` (a `MerchantModule` concern,
 * `MerchantEntity.kybStatus`; `MerchantModule` must never depend on
 * `PaymentModule`). Deliberately its own endpoint
 * (`POST /webhooks/kyb`, `KybWebhookGuard`'s own `X-KYB-Signature`/
 * `KYB_WEBHOOK_SECRET`), not reused from `POST /webhooks/kyc` — a KYC
 * decision should never be able to resolve a KYB application or vice
 * versa, even in a misconfiguration.
 */
@ApiTags('Webhooks')
@Controller('webhooks')
export class KybWebhookController {
  private readonly logger = new Logger(KybWebhookController.name);

  constructor(private readonly merchantService: MerchantService) {}

  @Post('kyb')
  @UseGuards(KybWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'KYB provider review decision callback (verified via X-KYB-Signature) — see PersonaKybProviderAdapter',
  })
  @ApiResponse({ status: 200, description: 'Decision recorded' })
  @ApiResponse({ status: 401, description: 'Missing/invalid X-KYB-Signature header' })
  async kybWebhook(
    @Body()
    body: {
      data?: { attributes?: { name?: string; payload?: { data?: { id?: string; attributes?: { status?: string } } } } };
    },
  ): Promise<{ received: true }> {
    const inquiry = body?.data?.attributes?.payload?.data;
    const applicationId = inquiry?.id;
    const eventName = body?.data?.attributes?.name;
    const status = mapPersonaInquiryStatus(inquiry?.attributes?.status);
    this.logger.debug(`KYB webhook received: applicationId=${applicationId} event=${eventName} status=${status}`);

    if (!applicationId || status === 'PENDING') {
      return { received: true };
    }

    await this.merchantService.confirmKyb(
      applicationId,
      status === 'APPROVED' ? 'VERIFIED' : 'REJECTED',
      status === 'REJECTED' ? `Declined via Persona event ${eventName ?? 'unknown'}` : undefined,
    );
    return { received: true };
  }
}
