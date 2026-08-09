import { DomainEvent } from './domain-event.base';
import { PaymentStatus } from '../value-objects/payment-status.vo';

/**
 * Emitted when a new payment intent is created
 */
export class PaymentIntentCreatedEvent extends DomainEvent {
  constructor(
    public readonly paymentId: string,
    public readonly merchantId: string,
    public readonly amountMinorUnits: string,
    public readonly currency: string,
    public readonly idempotencyKey: string,
  ) {
    super({ aggregateId: paymentId, aggregateType: 'Payment' });
  }

  get eventName(): string {
    return 'payment.intent.created';
  }
}

/**
 * Emitted when a payment is successfully charged
 */
export class PaymentChargedEvent extends DomainEvent {
  constructor(
    public readonly paymentId: string,
    public readonly pspTransactionId: string,
    public readonly pspProvider: string,
    public readonly amountMinorUnits: string,
    public readonly currency: string,
  ) {
    super({ aggregateId: paymentId, aggregateType: 'Payment' });
  }

  get eventName(): string {
    return 'payment.charged';
  }
}

/**
 * Emitted when a payment fails
 */
export class PaymentFailedEvent extends DomainEvent {
  constructor(
    public readonly paymentId: string,
    public readonly reason: string,
    public readonly pspErrorCode?: string,
  ) {
    super({ aggregateId: paymentId, aggregateType: 'Payment' });
  }

  get eventName(): string {
    return 'payment.failed';
  }
}

/**
 * Emitted when a payment requires 3DS action
 */
export class PaymentRequiresActionEvent extends DomainEvent {
  constructor(
    public readonly paymentId: string,
    public readonly actionUrl: string,
    public readonly riskScore: number,
  ) {
    super({ aggregateId: paymentId, aggregateType: 'Payment' });
  }

  get eventName(): string {
    return 'payment.requires_action';
  }
}

/**
 * Emitted when a payment is refunded
 */
export class PaymentRefundedEvent extends DomainEvent {
  constructor(
    public readonly paymentId: string,
    public readonly refundId: string,
    public readonly amountMinorUnits: string,
    public readonly currency: string,
    public readonly reason: string,
  ) {
    super({ aggregateId: paymentId, aggregateType: 'Payment' });
  }

  get eventName(): string {
    return 'payment.refunded';
  }
}

/**
 * Emitted when a PSP reports a chargeback/dispute on a payment
 */
export class PaymentDisputedEvent extends DomainEvent {
  constructor(
    public readonly paymentId: string,
    public readonly reason?: string,
  ) {
    super({ aggregateId: paymentId, aggregateType: 'Payment' });
  }

  get eventName(): string {
    return 'payment.disputed';
  }
}

/**
 * Emitted when payment status changes (for SSE streaming)
 */
export class PaymentStatusChangedEvent extends DomainEvent {
  constructor(
    public readonly paymentId: string,
    public readonly previousStatus: PaymentStatus,
    public readonly newStatus: PaymentStatus,
    public readonly metadata?: Record<string, unknown>,
  ) {
    super({ aggregateId: paymentId, aggregateType: 'Payment' });
  }

  get eventName(): string {
    return 'payment.status.changed';
  }
}
