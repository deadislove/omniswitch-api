import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { ReconciliationStatus } from '../../../domain/aggregates/reconciliation-run.aggregate';

@Entity('reconciliation_runs')
@Index(['pspProvider', 'ranAt'])
export class ReconciliationRunEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'psp_provider' })
  pspProvider!: string;

  @Column({ name: 'window_start', type: 'timestamptz' })
  windowStart!: Date;

  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd!: Date;

  @Column({ name: 'transactions_checked', type: 'int' })
  transactionsChecked!: number;

  @Column({ name: 'mismatches', type: 'jsonb', default: '[]' })
  mismatches!: Record<string, unknown>[];

  @Column({ type: 'varchar' })
  status!: ReconciliationStatus;

  @Column({ name: 'ran_at', type: 'timestamptz' })
  ranAt!: Date;
}
