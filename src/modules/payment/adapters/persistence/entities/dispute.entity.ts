import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { DisputeStatus } from '../../../domain/aggregates/dispute.aggregate';
import { PSPProvider } from '../../../domain/aggregates/payment.aggregate';
import { DisputeAutoDecision } from '../../../domain/services/dispute-policy';

@Entity('disputes')
@Index(['merchantId', 'status'])
@Index(['pspDisputeId'], { unique: true })
export class DisputeEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'payment_id' })
  @Index()
  paymentId: string;

  @Column({ name: 'merchant_id' })
  merchantId: string;

  @Column({ name: 'psp_provider', type: 'varchar' })
  pspProvider: PSPProvider;

  /** The PSP's own id for this dispute/chargeback — how a later resolution webhook finds this record. */
  @Column({ name: 'psp_dispute_id' })
  pspDisputeId: string;

  @Column({ name: 'amount_minor_units', type: 'bigint' })
  amountMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ nullable: true })
  reason?: string;

  @Column({ type: 'varchar', default: 'NEEDS_RESPONSE' })
  status: DisputeStatus;

  @Column({ name: 'respond_by', type: 'timestamptz' })
  respondBy: Date;

  @Column({ type: 'text', nullable: true })
  evidence?: string;

  /** Explicit type: 'varchar' — see MerchantEntity's mfaSecretCiphertext comment for why a `| undefined`-typed column needs this. */
  @Column({ name: 'auto_decision', type: 'varchar', nullable: true })
  autoDecision?: DisputeAutoDecision;

  /**
   * Snapshotted from PaymentEntity.delegationId/initiatedBy at
   * DisputeService.recordDispute() time — a snapshot, not a live join,
   * because "was this the result of an agent-initiated charge" is a
   * question about the payment's state *at charge time*, not whatever a
   * future migration/backfill might change it to later. `null` when the
   * underlying payment record couldn't be found (shouldn't happen — a
   * dispute is always reported against an existing SUCCEEDED payment —
   * but this service reacts to whatever a PSP webhook claims).
   */
  @Column({ name: 'delegation_id', type: 'uuid', nullable: true })
  delegationId?: string;

  @Column({ name: 'initiated_by', type: 'varchar', nullable: true })
  initiatedBy?: 'human' | 'agent';

  /**
   * Audit-only snapshot of the charging merchant's risk tier at the exact
   * moment `decideAutoDisposition()` ran (see dispute-policy.ts's
   * merchantRiskTier param and DisputeService.recordDispute()) — not a
   * live join, so a later tier change never rewrites what this dispute's
   * decision was actually based on. `null` when the merchant had no
   * evaluable tier at that moment (RiskTieringService.evaluateMerchant()
   * returned `null` — e.g. too little dispute history — which the policy
   * treated the same as 'MEDIUM').
   */
  @Column({ name: 'merchant_risk_tier_at_decision', type: 'varchar', nullable: true })
  merchantRiskTierAtDecision?: 'LOW' | 'MEDIUM' | 'HIGH';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
