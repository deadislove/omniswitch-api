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

  /** See SpendPolicy.requireApprovalAboveAmount's docblock. Null means no approval gate — every charge within the other limits auto-executes. */
  @Column({ name: 'require_approval_above_amount_minor_units', type: 'bigint', nullable: true })
  requireApprovalAboveAmountMinorUnits: string | null;

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

  // Envelope-encrypted (Vault Transit, same VaultTransitService/key as
  // merchants.hmac_secret_ciphertext — see secret-management.md) per-agent
  // HMAC signing key, generated once at delegation creation. Nullable: a
  // delegation created before this column existed has no key, and
  // HmacSignatureGuard treats that as "must be revoked and reissued to get
  // one" rather than papering over it with a bypass — see that guard's
  // docblock.
  @Column({ name: 'signing_key_ciphertext', type: 'varchar', nullable: true })
  signingKeyCiphertext: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
