import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID as uuidv4 } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';
import { PaymentAggregate, PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { AdyenNotificationRequestItem } from '../../adapters/psp/adyen/adyen-webhook.guard';
import { PaymentMapper } from '../../adapters/persistence/mappers/payment.mapper';
import { DisputeService } from './dispute.service';
import { ChargeLedgerParamsResolverService } from './charge-ledger-params-resolver.service';
import { ReserveService } from './reserve.service';

/**
 * Webhook Processing Service
 * Normalizes Stripe/Adyen webhook payloads (already signature-verified by
 * StripeWebhookGuard/AdyenWebhookGuard) into PaymentAggregate transitions.
 *
 * PSPs redeliver webhooks at least once (on timeout, 5xx, etc.), so every
 * handler here must be idempotent — replays of an already-applied event are
 * logged and dropped rather than re-applied or thrown as errors.
 */
@Injectable()
export class WebhookProcessingService {
  private readonly logger = new Logger(WebhookProcessingService.name);

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly disputeService: DisputeService,
    private readonly chargeLedgerParams: ChargeLedgerParamsResolverService,
    private readonly reserveService: ReserveService,
  ) {}

  async handleStripeEvent(event: any): Promise<void> {
    const type = event?.type;
    const obj = event?.data?.object;
    if (!type || !obj?.id) {
      this.logger.warn('Stripe webhook missing type or data.object.id, ignoring');
      return;
    }

    switch (type) {
      case 'payment_intent.succeeded':
        await this.markSucceeded('STRIPE', obj.id, obj);
        break;
      case 'payment_intent.payment_failed':
        await this.markFailed(
          'STRIPE',
          obj.id,
          obj?.last_payment_error?.message ?? 'PSP reported payment failure',
          obj?.last_payment_error?.code,
        );
        break;
      case 'charge.dispute.created':
        // obj.id is the Dispute's own id (dp_xxx) — kept separately from the
        // PaymentIntent id (obj.payment_intent) so a later charge.dispute.closed
        // event (which only carries the dispute id, not the PaymentIntent id)
        // can still find this dispute record.
        await this.markDisputed('STRIPE', obj?.payment_intent ?? obj.id, obj.id, obj?.reason);
        break;
      case 'charge.dispute.closed':
        // obj.status is 'won' | 'lost' | 'warning_closed' — only the first
        // two are a real resolution; 'warning_closed' means the dispute was
        // withdrawn before ever needing a merchant response.
        if (obj?.status === 'won' || obj?.status === 'lost') {
          await this.disputeService.resolveByPspDisputeId(obj.id, obj.status === 'won' ? 'WON' : 'LOST');
        }
        break;
      default:
        this.logger.debug(`Unhandled Stripe event type: ${type}`);
    }
  }

  async handleAdyenNotification(body: { notificationItems?: Array<{ NotificationRequestItem: AdyenNotificationRequestItem }> }): Promise<void> {
    const items = body?.notificationItems ?? [];

    for (const wrapper of items) {
      const item = wrapper?.NotificationRequestItem;
      if (!item?.pspReference) continue;

      const success = item.success === 'true';

      switch (item.eventCode) {
        case 'AUTHORISATION':
          if (success) {
            await this.markSucceeded('ADYEN', item.pspReference, item);
          } else {
            await this.markFailed('ADYEN', item.pspReference, item.reason ?? 'Adyen authorisation refused');
          }
          break;
        case 'REFUND':
          this.logger.log(`Adyen REFUND notification for pspReference=${item.pspReference}, success=${success}`);
          break;
        case 'NOTIFICATION_OF_CHARGEBACK':
          // item.pspReference here is the chargeback's own reference — kept
          // as this dispute's pspDisputeId so a later CHARGEBACK/
          // CHARGEBACK_REVERSED notification can resolve it (see below).
          // item.originalReference points back to the original payment.
          await this.markDisputed('ADYEN', item.originalReference ?? item.pspReference, item.pspReference, item.reason);
          break;
        case 'CHARGEBACK':
        case 'CHARGEBACK_REVERSED':
          // Simplification vs. real Adyen (whose originalReference chains
          // notification-to-notification rather than always back to the
          // first one): this mock assumes item.originalReference on both of
          // these points at NOTIFICATION_OF_CHARGEBACK's own pspReference,
          // i.e. this dispute's pspDisputeId. CHARGEBACK is the final,
          // actual debit (LOST); CHARGEBACK_REVERSED is the bank reversing
          // it back to the merchant (WON).
          if (item.originalReference) {
            await this.disputeService.resolveByPspDisputeId(
              item.originalReference,
              item.eventCode === 'CHARGEBACK_REVERSED' ? 'WON' : 'LOST',
            );
          }
          break;
        default:
          this.logger.debug(`Unhandled Adyen eventCode: ${item.eventCode}`);
      }
    }
  }

  private async markSucceeded(provider: PSPProvider, pspTransactionId: string, raw: unknown): Promise<void> {
    const payment = await this.paymentRepository.findByPspTransactionId(pspTransactionId);
    if (!payment) {
      this.logger.warn(`${provider} success webhook for unknown transaction ${pspTransactionId}`);
      return;
    }
    if (payment.status === PaymentStatus.SUCCEEDED) {
      this.logger.debug(`Duplicate ${provider} webhook: payment ${payment.id} already SUCCEEDED`);
      return;
    }
    if (payment.status !== PaymentStatus.PROCESSING && payment.status !== PaymentStatus.REQUIRES_ACTION) {
      this.logger.warn(
        `Ignoring ${provider} success webhook for payment ${payment.id} in unexpected status ${payment.status}`,
      );
      return;
    }

    if (payment.status === PaymentStatus.REQUIRES_ACTION) {
      payment.completeThreeDS({ authenticated: true });
    }
    payment.markSucceeded(pspTransactionId, raw as Record<string, unknown>);

    // This webhook is the first time funds are confirmed captured for a
    // payment that went through 3DS or an async/delayed PSP authorization —
    // book the ledger entry here, same as the saga's immediate-capture path
    // and PaymentLifecycleService.capture(). The earlier status checks above
    // (already-SUCCEEDED is a no-op) keep this from double-booking on a
    // redelivered webhook.
    // `payment.splits` — recorded on the payment intent before the PSP was
    // ever called (see PaymentCheckoutSaga.execute()'s docblock on why),
    // survives here regardless of the REQUIRES_ACTION detour this webhook
    // is resolving. Passed back into resolve() so it re-validates against
    // current merchant state (a connected account could in principle have
    // been deactivated between the original request and this webhook) and
    // is threaded through to the ledger entries below — without this, a
    // split charge that needed a 3DS challenge would silently lose its
    // split the moment the challenge completed.
    const { platformFee, settlementConversion, reserveHold, splits } = await this.chargeLedgerParams.resolve(payment.metadata.merchantId, payment.amount, payment.splits);
    if (settlementConversion) {
      payment.recordSettlementConversion({
        currency: settlementConversion.convertedNetAmount.currency.code,
        rate: settlementConversion.rate,
        provider: settlementConversion.provider,
      });
    }
    const outboxEvent = LedgerOutboxEvent.createChargeEntries({
      id: uuidv4(),
      paymentId: payment.id,
      merchantId: payment.metadata.merchantId,
      amount: payment.amount,
      platformFee,
      settlementConversion,
      reserveHold,
      splits,
    });

    await this.dataSource.transaction(async (manager) => {
      await manager.save(PaymentMapper.toPersistence(payment));
      await this.ledgerOutbox.saveWithPayment(payment.id, outboxEvent, manager);
      if (reserveHold) {
        await this.reserveService.recordHold(
          { paymentId: payment.id, merchantId: payment.metadata.merchantId, amount: reserveHold.amount, holdDays: reserveHold.holdDays },
          manager,
        );
      }
    });

    this.publish(payment);
    this.logger.log(`Payment ${payment.id} confirmed SUCCEEDED via ${provider} webhook`);
  }

  private async markFailed(
    provider: PSPProvider,
    pspTransactionId: string,
    reason: string,
    errorCode?: string,
  ): Promise<void> {
    const payment = await this.paymentRepository.findByPspTransactionId(pspTransactionId);
    if (!payment) {
      this.logger.warn(`${provider} failure webhook for unknown transaction ${pspTransactionId}`);
      return;
    }
    if (payment.status === PaymentStatus.FAILED) {
      this.logger.debug(`Duplicate ${provider} webhook: payment ${payment.id} already FAILED`);
      return;
    }
    if (payment.status !== PaymentStatus.PROCESSING && payment.status !== PaymentStatus.REQUIRES_ACTION) {
      this.logger.warn(
        `Ignoring ${provider} failure webhook for payment ${payment.id} in unexpected status ${payment.status}`,
      );
      return;
    }

    payment.markFailed(reason, errorCode);
    await this.paymentRepository.update(payment);
    this.publish(payment);
    this.logger.log(`Payment ${payment.id} marked FAILED via ${provider} webhook: ${reason}`);
  }

  private async markDisputed(
    provider: PSPProvider,
    pspTransactionId: string,
    pspDisputeId: string,
    reason?: string,
  ): Promise<void> {
    const payment = await this.paymentRepository.findByPspTransactionId(pspTransactionId);
    if (!payment) {
      this.logger.warn(`${provider} dispute webhook for unknown transaction ${pspTransactionId}`);
      return;
    }
    if (payment.status === PaymentStatus.DISPUTED) {
      this.logger.debug(`Duplicate ${provider} webhook: payment ${payment.id} already DISPUTED`);
      return;
    }
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      this.logger.warn(
        `Ignoring ${provider} dispute webhook for payment ${payment.id} in unexpected status ${payment.status}`,
      );
      return;
    }

    payment.markDisputed(reason);
    await this.paymentRepository.update(payment);
    await this.disputeService.recordDispute({
      paymentId: payment.id,
      merchantId: payment.metadata.merchantId,
      pspProvider: provider,
      pspDisputeId,
      amount: payment.amount,
      reason,
    });
    this.publish(payment);
    this.logger.warn(`Payment ${payment.id} marked DISPUTED via ${provider} webhook`);
  }

  private publish(payment: PaymentAggregate): void {
    const events = payment.pullDomainEvents();
    for (const event of events) {
      this.eventEmitter.emit(event.eventName, event);
    }
  }
}
