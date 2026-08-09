import 'dotenv/config';
import { DataSource } from 'typeorm';

import { PaymentEntity } from '../modules/payment/adapters/persistence/entities/payment.entity';
import { LedgerOutboxEntity } from '../modules/payment/adapters/persistence/entities/ledger-outbox.entity';
import { ReconciliationRunEntity } from '../modules/payment/adapters/persistence/entities/reconciliation-run.entity';
import { DisputeEntity } from '../modules/payment/adapters/persistence/entities/dispute.entity';
import { ReserveHoldEntity } from '../modules/payment/adapters/persistence/entities/reserve-hold.entity';
import { SubscriptionEntity } from '../modules/payment/adapters/persistence/entities/subscription.entity';
import { PlanEntity } from '../modules/payment/adapters/persistence/entities/plan.entity';
import { PayoutEntity } from '../modules/payment/adapters/persistence/entities/payout.entity';
import { PayoutSweepRunEntity } from '../modules/payment/adapters/persistence/entities/payout-sweep-run.entity';
import { DelegationEntity } from '../modules/payment/adapters/persistence/entities/delegation.entity';
import { MerchantEntity } from '../modules/merchant/merchant.entity';

/**
 * TypeORM CLI data source. Deliberately separate from app.module.ts's
 * TypeOrmModule.forRootAsync() — the CLI needs a plain DataSource it can
 * import directly (no Nest DI container), and migrations must run against
 * the master only, never the master/replica `replication` config the app
 * uses at runtime.
 *
 * `synchronize` is intentionally absent (defaults to false) — this is the
 * one place in the codebase where the schema is allowed to diverge from
 * "whatever synchronize would auto-generate," specifically so migrations
 * generated here are the actual source of truth going forward.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_MASTER_HOST || 'localhost',
  port: Number(process.env.DB_MASTER_PORT) || 5432,
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'omniswitch',
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
      : false,
  entities: [PaymentEntity, LedgerOutboxEntity, MerchantEntity, ReconciliationRunEntity, DisputeEntity, ReserveHoldEntity, SubscriptionEntity, PlanEntity, PayoutEntity, PayoutSweepRunEntity, DelegationEntity],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  migrationsTableName: 'typeorm_migrations',
});
