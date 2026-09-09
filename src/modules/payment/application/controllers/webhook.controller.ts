import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint, ApiResponse } from '@nestjs/swagger';
import { StripeWebhookGuard } from '../../adapters/psp/stripe/stripe-webhook.guard';
import { AdyenWebhookGuard } from '../../adapters/psp/adyen/adyen-webhook.guard';
import { BankTransferWebhookGuard } from '../../adapters/bank/bank-transfer-webhook.guard';
import { WebhookProcessingService } from '../services/webhook-processing.service';
import { PayoutService } from '../services/payout.service';
import { BankTransferPort } from '../../ports/outbound/bank-transfer.port';

/**
 * Webhook Controller
 * Receives asynchronous PSP callbacks (3DS resolution, delayed authorisation,
 * refund completion, chargebacks) and, since `AchBankTransferAdapter`/
 * `WireBankTransferAdapter` were added, real bank-transfer-rail settlement
 * callbacks too. No JWT here — none of these callers are one of our
 * merchants, so authentication is the signature check in each guard instead.
 */
@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhookProcessing: WebhookProcessingService,
    private readonly payoutService: PayoutService,
    private readonly bankTransferPort: BankTransferPort,
  ) {}

  @Post('stripe')
  @UseGuards(StripeWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook receiver (verified via Stripe-Signature)' })
  @ApiResponse({ status: 200, description: 'Event accepted for processing' })
  @ApiResponse({ status: 400, description: 'Missing/invalid Stripe-Signature header' })
  async stripeWebhook(@Body() event: any): Promise<{ received: true }> {
    this.logger.debug(`Stripe webhook received: ${event?.type}`);
    await this.webhookProcessing.handleStripeEvent(event);
    return { received: true };
  }

  @Post('adyen')
  @UseGuards(AdyenWebhookGuard)
  @HttpCode(HttpStatus.OK)
  // Adyen's dashboard test button and delivery retries don't send an
  // Authorization/API-key header, so this intentionally isn't documented
  // as a normal bearer-authed route in Swagger.
  @ApiExcludeEndpoint()
  async adyenWebhook(@Body() body: any): Promise<{ notificationResponse: '[accepted]' }> {
    await this.webhookProcessing.handleAdyenNotification(body);
    // Adyen requires exactly this response body to stop retrying delivery.
    return { notificationResponse: '[accepted]' };
  }

  /**
   * Real Dwolla-shaped notification: `{id, topic, resourceId, _links}` —
   * an event envelope with no settlement detail inline, matching
   * developers.dwolla.com/docs/webhook-events (see
   * `AchBankTransferAdapter`'s docblock for the full citation). `topic`
   * alone is enough to know settled vs. failed; a failure additionally
   * needs a reason, which isn't in the envelope — so on failure this
   * follows up with `bankTransferPort.getTransferStatus(resourceId)`,
   * the same authenticated-GET step a real receiver would make against
   * `_links.resource.href`, before recording the outcome.
   */
  @Post('bank-transfer')
  @UseGuards(BankTransferWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Bank/ACH/Wire transfer rail settlement notification (verified via X-Bank-Transfer-Signature) — see AchBankTransferAdapter/WireBankTransferAdapter',
  })
  @ApiResponse({ status: 200, description: 'Settlement outcome recorded' })
  @ApiResponse({ status: 401, description: 'Missing/invalid X-Bank-Transfer-Signature header' })
  async bankTransferWebhook(
    @Body() body: { id: string; topic: string; resourceId: string },
  ): Promise<{ received: true }> {
    this.logger.debug(`Bank transfer webhook received: id=${body?.id} topic=${body?.topic} resourceId=${body?.resourceId}`);
    const settled = body.topic === 'customer_transfer_completed';
    let reason: string | undefined;
    if (!settled) {
      const followUp = await this.bankTransferPort.getTransferStatus(body.resourceId);
      reason = followUp?.reason;
    }
    await this.payoutService.confirmTransfer(body.resourceId, settled ? 'SETTLED' : 'FAILED', reason);
    return { received: true };
  }
}
