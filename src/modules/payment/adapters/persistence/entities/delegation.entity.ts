import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { DelegationStatus } from '../../../domain/aggregates/delegation.aggregate';

@Entity('delegations')
@Index(['merchantId', 'status'])
export class DelegationEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'merchant_id' })
  merchantId: string;

  @Column({ name: 'agent_name' })
  agentName: string;

  @Column({ name: 'per_transaction_limit_minor_units', type: 'bigint' })
  perTransactionLimitMinorUnits: string;

  @Column({ name: 'monthly_limit_minor_units', type: 'bigint' })
  monthlyLimitMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ name: 'allowed_categories', type: 'simple-array', nullable: true })
  allowedCategories: string[] | null;

  @Column({ type: 'varchar', default: 'ACTIVE' })
  status: DelegationStatus;

  @Column({ name: 'current_month_key' })
  currentMonthKey: string;

  @Column({ name: 'current_month_spent_minor_units', type: 'bigint', default: 0 })
  currentMonthSpentMinorUnits: string;

  @Column({ unique: true })
  jti: string;

  @Column({ name: 'token_expires_at', type: 'timestamptz' })
  tokenExpiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
