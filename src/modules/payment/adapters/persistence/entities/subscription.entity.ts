import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { SubscriptionStatus, BillingInterval } from '../../../domain/aggregates/subscription.aggregate';
import { PSPProvider } from '../../../domain/aggregates/payment.aggregate';

@Entity('subscriptions')
@Index(['merchantId', 'status'])
export class SubscriptionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'merchant_id' })
  merchantId: string;

  @Column({ name: 'customer_id' })
  customerId: string;

  @Column({ name: 'amount_minor_units', type: 'bigint' })
  amountMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ type: 'varchar' })
  interval: BillingInterval;

  @Column({ name: 'interval_count', type: 'int' })
  intervalCount: number;

  @Column({ name: 'payment_method_id' })
  paymentMethodId: string;

  @Column({ type: 'varchar' })
  status: SubscriptionStatus;

  @Column({ name: 'current_period_start', type: 'timestamptz' })
  currentPeriodStart: Date;

  @Column({ name: 'current_period_end', type: 'timestamptz' })
  currentPeriodEnd: Date;

  @Column({ name: 'cancel_at_period_end', default: false })
  cancelAtPeriodEnd: boolean;

  @Column({ name: 'failed_attempts', type: 'int', default: 0 })
  failedAttempts: number;

  @Column({ name: 'order_id', nullable: true })
  orderId?: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ name: 'canceled_at', type: 'timestamptz', nullable: true })
  canceledAt?: Date | null;

  /** Provenance only — see Subscription aggregate's docblock for why this isn't a live reference to the Plan row. */
  @Column({ name: 'plan_id', type: 'uuid', nullable: true })
  planId?: string | null;

  /** Same currency as amountMinorUnits — a credit only ever arises from a plan change within the subscription's own currency (see computeDowngradeCredit()'s guard), so there's no separate currency column. */
  @Column({ name: 'pending_credit_minor_units', type: 'bigint', nullable: true })
  pendingCreditMinorUnits?: string | null;

  /** When the next dunning retry is allowed to run — see Subscription.recordFailedCharge()'s docblock. Meaningless while status isn't PAST_DUE. */
  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt?: Date | null;

  /** The PSP's own decline code from the most recent failed charge attempt, if it returned one — see Subscription.recordFailedCharge()'s docblock and classifyDeclineCode(). Cleared on a successful charge. */
  @Column({ name: 'last_decline_code', type: 'varchar', nullable: true })
  lastDeclineCode?: string | null;

  /** Which PSP produced lastDeclineCode — needed to classify it against the right PSP's own decline-code vocabulary (Phase 1's per-PSP HARD_DECLINE_CODES; see classifyDeclineCode()'s docblock). Cleared alongside lastDeclineCode on a successful charge. */
  @Column({ name: 'last_decline_psp_provider', type: 'varchar', nullable: true })
  lastDeclinePspProvider?: PSPProvider | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
