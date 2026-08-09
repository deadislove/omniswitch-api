import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint, ApiResponse } from '@nestjs/swagger';
import { StripeWebhookGuard } from '../../adapters/psp/stripe/stripe-webhook.guard';
import { AdyenWebhookGuard } from '../../adapters/psp/adyen/adyen-webhook.guard';
import { WebhookProcessingService } from '../services/webhook-processing.service';

/**
 * Webhook Controller
 * Receives asynchronous PSP callbacks (3DS resolution, delayed authorisation,
 * refund completion, chargebacks). No JWT here — the PSP is not one of our
 * merchants, so authentication is the signature check in each guard instead.
 */
@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookProcessing: WebhookProcessingService) {}

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
}
