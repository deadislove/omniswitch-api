import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { KycWebhookGuard } from './kyc-webhook.guard';
import { MerchantService } from './merchant.service';

/**
 * KYC Webhook Controller
 * Receives a real KYC provider's async review decision
 * (`PersonaKycProviderAdapter`'s counterpart) — kept in `MerchantModule`,
 * not alongside the PSP/bank-transfer webhooks in `PaymentModule`'s
 * `WebhookController`, since KYC review is a `MerchantModule` concern
 * (`MerchantEntity.kycStatus`) and `MerchantModule` must never depend on
 * `PaymentModule` (the reverse already holds — see
 * `docs/technical/architecture.md`'s module graph). No JWT — the KYC
 * provider is not one of our merchants, so authentication is
 * `KycWebhookGuard`'s signature check instead.
 */
@ApiTags('Webhooks')
@Controller('webhooks')
export class KycWebhookController {
  private readonly logger = new Logger(KycWebhookController.name);

  constructor(private readonly merchantService: MerchantService) {}

  @Post('kyc')
  @UseGuards(KycWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'KYC provider review decision callback (verified via X-KYC-Signature) — see PersonaKycProviderAdapter',
  })
  @ApiResponse({ status: 200, description: 'Decision recorded' })
  @ApiResponse({ status: 401, description: 'Missing/invalid X-KYC-Signature header' })
  async kycWebhook(
    @Body() body: { applicationId: string; status: 'approved' | 'rejected'; reason?: string },
  ): Promise<{ received: true }> {
    this.logger.debug(`KYC webhook received: applicationId=${body?.applicationId} status=${body?.status}`);
    await this.merchantService.confirmKyc(
      body.applicationId,
      body.status === 'approved' ? 'VERIFIED' : 'REJECTED',
      body.reason,
    );
    return { received: true };
  }
}
