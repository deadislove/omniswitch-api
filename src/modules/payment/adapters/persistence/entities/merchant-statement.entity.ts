import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity('merchant_statements')
@Index(['merchantId', 'periodStart', 'periodEnd'], { unique: true })
export class MerchantStatementEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'merchant_id' })
  merchantId!: string;

  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart!: Date;

  @Column({ name: 'period_end', type: 'timestamptz' })
  periodEnd!: Date;

  @Column({ name: 'breakdowns', type: 'jsonb' })
  breakdowns!: Record<string, unknown>[];

  @Column({ name: 'generated_at', type: 'timestamptz' })
  generatedAt!: Date;
}
