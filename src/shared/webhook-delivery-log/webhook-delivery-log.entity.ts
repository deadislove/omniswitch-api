import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * One recorded attempt to deliver an outbound WEBHOOK-channel
 * notification — dispute/subscription/AML-review/sanctions-screening
 * events, whichever event families a merchant has configured
 * `*NotificationChannel: 'WEBHOOK'` for. Deliberately WEBHOOK-channel
 * only, not EMAIL/SLACK too: this exists so a merchant can inspect and
 * replay deliveries to *their own* receiving endpoint the same way
 * Stripe's dashboard lets an integrator do for their webhooks — an
 * EMAIL/SLACK delivery has no equivalent "my server didn't get this,
 * let me replay it" story, since there's no endpoint of the merchant's
 * own on the other end.
 *
 * Write side: `WebhookDeliveryLogService.record()`, called by each of
 * the four `Webhook*NotificationAdapter` classes (dispute, subscription,
 * AML review, sanctions) immediately after attempting delivery — success
 * or failure, both recorded, so a merchant can see *why* a delivery is
 * missing from their own logs, not just that it is. Read/replay side:
 * `WebhookDeliveryAdminController`.
 */
@Entity('webhook_deliveries')
@Index(['merchantId', 'createdAt'])
export class WebhookDeliveryLogEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'merchant_id' })
  merchantId: string;

  /** e.g. 'dispute.created', 'subscription.past_due', 'aml_review.flagged', 'sanctions_screening.flagged' — the payload's own `event` field, not re-derived. */
  @Column({ name: 'event_type' })
  eventType: string;

  @Column({ name: 'target_url' })
  targetUrl: string;

  /** The exact JSON body sent — a merchant inspecting a delivery needs to see what was actually sent, not a summary of it. */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column()
  success: boolean;

  /** Null when the failure was a network error/timeout — there was never a response to read a status from, distinct from a real non-2xx response. */
  @Column({ name: 'status_code', type: 'int', nullable: true })
  statusCode?: number | null;

  @Column({ name: 'error_message', type: 'varchar', nullable: true })
  errorMessage?: string | null;

  @Column({ name: 'latency_ms', type: 'int' })
  latencyMs: number;

  /**
   * Set when this row *is* a manual replay of an earlier delivery — the
   * original delivery's own id, not a self-reference chain (replaying a
   * replay still points at the same original, so every attempt for one
   * logical event is one hop from the row that started it, not an
   * arbitrarily deep chain to walk).
   */
  @Column({ name: 'replay_of_delivery_id', type: 'uuid', nullable: true })
  @Index()
  replayOfDeliveryId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
