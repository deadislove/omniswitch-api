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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
