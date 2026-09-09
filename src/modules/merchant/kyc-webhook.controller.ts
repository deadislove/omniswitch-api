import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { KycWebhookGuard } from './kyc-webhook.guard';
import { MerchantService } from './merchant.service';
import { mapPersonaInquiryStatus } from './persona-inquiry-status';

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
 *
 * Body shape confirmed against Persona's real webhook event envelope
 * (docs.withpersona.com/events, docs.withpersona.com/webhooks) — a real
 * Persona webhook is an *event* (`data.attributes.name`, e.g.
 * `inquiry.approved`), with the actual Inquiry nested underneath it
 * (`data.attributes.payload.data`), not a flat `{applicationId, status}`
 * body an earlier revision of this controller assumed. See
 * `PersonaKycProviderAdapter`'s docblock for the same fidelity note
 * applied to the synchronous creation response.
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
    @Body()
    body: {
      data?: { attributes?: { name?: string; payload?: { data?: { id?: string; attributes?: { status?: string } } } } };
    },
  ): Promise<{ received: true }> {
    const inquiry = body?.data?.attributes?.payload?.data;
    const applicationId = inquiry?.id;
    const eventName = body?.data?.attributes?.name;
    const status = mapPersonaInquiryStatus(inquiry?.attributes?.status);
    this.logger.debug(`KYC webhook received: applicationId=${applicationId} event=${eventName} status=${status}`);

    if (!applicationId || status === 'PENDING') {
      // Real Persona sends non-decision events too (inquiry.created,
      // inquiry.started, inquiry.marked-for-review, ...) — only a
      // decision event should ever reach confirmKyc().
      return { received: true };
    }

    await this.merchantService.confirmKyc(
      applicationId,
      status === 'APPROVED' ? 'VERIFIED' : 'REJECTED',
      status === 'REJECTED' ? `Declined via Persona event ${eventName ?? 'unknown'}` : undefined,
    );
    return { received: true };
  }
}
