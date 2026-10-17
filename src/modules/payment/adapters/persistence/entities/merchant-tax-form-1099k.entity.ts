import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity('merchant_tax_forms_1099k')
@Index(['merchantId', 'taxYear'], { unique: true })
export class MerchantTaxForm1099KEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'merchant_id' })
  merchantId!: string;

  @Column({ name: 'tax_year', type: 'int' })
  taxYear!: number;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode!: string;

  @Column({ name: 'gross_amount_minor_units', type: 'bigint' })
  grossAmountMinorUnits!: string;

  @Column({ name: 'transaction_count', type: 'int' })
  transactionCount!: number;

  @Column({ name: 'monthly_amounts_minor_units', type: 'jsonb' })
  monthlyAmountsMinorUnits!: string[];

  @Column({ name: 'threshold_applied_minor_units', type: 'bigint' })
  thresholdAppliedMinorUnits!: string;

  @Column({ name: 'reportable' })
  reportable!: boolean;

  @Column({ name: 'generated_at', type: 'timestamptz' })
  generatedAt!: Date;
}
