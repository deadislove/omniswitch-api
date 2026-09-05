import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint, ApiResponse } from '@nestjs/swagger';
import { StripeWebhookGuard } from '../../adapters/psp/stripe/stripe-webhook.guard';
import { AdyenWebhookGuard } from '../../adapters/psp/adyen/adyen-webhook.guard';
import { BankTransferWebhookGuard } from '../../adapters/bank/bank-transfer-webhook.guard';
import { WebhookProcessingService } from '../services/webhook-processing.service';
import { PayoutService } from '../services/payout.service';

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

  @Post('bank-transfer')
  @UseGuards(BankTransferWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Bank/ACH/Wire transfer rail settlement callback (verified via X-Bank-Transfer-Signature) — see AchBankTransferAdapter/WireBankTransferAdapter',
  })
  @ApiResponse({ status: 200, description: 'Settlement outcome recorded' })
  @ApiResponse({ status: 401, description: 'Missing/invalid X-Bank-Transfer-Signature header' })
  async bankTransferWebhook(
    @Body() body: { transferId: string; status: 'settled' | 'failed'; reason?: string },
  ): Promise<{ received: true }> {
    this.logger.debug(`Bank transfer webhook received: transferId=${body?.transferId} status=${body?.status}`);
    await this.payoutService.confirmTransfer(
      body.transferId,
      body.status === 'settled' ? 'SETTLED' : 'FAILED',
      body.reason,
    );
    return { received: true };
  }
}
