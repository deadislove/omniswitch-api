import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { OutboxStatus } from '../../../domain/aggregates/ledger-outbox.aggregate';

@Entity('ledger_outbox')
@Index(['status', 'createdAt'])
@Index(['paymentId'])
export class LedgerOutboxEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'payment_id' })
  paymentId!: string;

  @Column({ name: 'event_type' })
  eventType!: string;

  @Column({ name: 'entries', type: 'jsonb' })
  entries!: Record<string, unknown>[];

  @Column({
    type: 'varchar',
    default: 'PENDING',
  })
  status!: OutboxStatus;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount!: number;

  @Column({ name: 'last_error', nullable: true })
  lastError?: string;

  @Column({ name: 'processed_at', nullable: true })
  processedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
