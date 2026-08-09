import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { APP_GUARD } from '@nestjs/core';

import { PaymentModule } from './modules/payment/payment.module';
import { MerchantModule } from './modules/merchant/merchant.module';
import { CorrelationIdMiddleware } from './shared/middleware/correlation-id.middleware';
import { PaymentEntity } from './modules/payment/adapters/persistence/entities/payment.entity';
import { LedgerOutboxEntity } from './modules/payment/adapters/persistence/entities/ledger-outbox.entity';
import { ReconciliationRunEntity } from './modules/payment/adapters/persistence/entities/reconciliation-run.entity';
import { DisputeEntity } from './modules/payment/adapters/persistence/entities/dispute.entity';
import { ReserveHoldEntity } from './modules/payment/adapters/persistence/entities/reserve-hold.entity';
import { SubscriptionEntity } from './modules/payment/adapters/persistence/entities/subscription.entity';
import { PlanEntity } from './modules/payment/adapters/persistence/entities/plan.entity';
import { PayoutEntity } from './modules/payment/adapters/persistence/entities/payout.entity';
import { PayoutSweepRunEntity } from './modules/payment/adapters/persistence/entities/payout-sweep-run.entity';
import { DelegationEntity } from './modules/payment/adapters/persistence/entities/delegation.entity';
import { MerchantEntity } from './modules/merchant/merchant.entity';
import { HealthController } from './health/health.controller';
import { MetricsController } from './observability/metrics.controller';
import { RedisThrottlerModule } from './shared/throttler/redis-throttler.module';
import { RedisThrottlerStorage } from './shared/throttler/redis-throttler-storage.service';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Database - Master/Replica routing
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        replication: {
          master: {
            host: config.get('DB_MASTER_HOST', 'localhost'),
            port: config.get<number>('DB_MASTER_PORT', 5432),
            username: config.get('DB_USERNAME', 'postgres'),
            password: config.get('DB_PASSWORD', 'postgres'),
            database: config.get('DB_NAME', 'omniswitch'),
          },
          slaves: [
            {
              host: config.get('DB_REPLICA_HOST', 'localhost'),
              port: config.get<number>('DB_REPLICA_PORT', 5433),
              username: config.get('DB_USERNAME', 'postgres'),
              password: config.get('DB_PASSWORD', 'postgres'),
              database: config.get('DB_NAME', 'omniswitch'),
            },
          ],
        },
        entities: [PaymentEntity, LedgerOutboxEntity, MerchantEntity, ReconciliationRunEntity, DisputeEntity, ReserveHoldEntity, SubscriptionEntity, PlanEntity, PayoutEntity, PayoutSweepRunEntity, DelegationEntity],
        // Schema is owned by TypeORM migrations (src/database/migrations/,
        // run via `npm run migration:run` / the Docker image's startup
        // command) in every environment, not just production — dev and
        // test used to silently diverge from prod by relying on
        // synchronize, which is exactly how schema drift goes unnoticed
        // until a deploy. See docs/technical/database-migrations.md.
        synchronize: false,
        logging: config.get('NODE_ENV') === 'development',
        // rejectUnauthorized: false accepts any certificate the server presents,
        // which defeats the point of enabling SSL — it stops MITM from being
        // *detected* but not the MITM itself. Verify against a CA bundle
        // instead; DB_SSL_CA can point at a mounted RDS/Cloud SQL CA cert.
        ssl: config.get('DB_SSL') === 'true'
          ? {
              rejectUnauthorized: true,
              ca: config.get('DB_SSL_CA') || undefined,
            }
          : false,
        extra: {
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        },
      }),
    }),

    // Rate Limiting - Redis-backed counters, shared across every replica.
    // The default ThrottlerStorageService is an in-process Map — with HPA
    // scaling this API to up to 20 pods (k8s/hpa.yaml), that would let the
    // *effective* per-merchant/per-IP limit multiply by however many pods a
    // client happens to land on, with zero coordination between them.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, RedisThrottlerModule],
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (config: ConfigService, storage: RedisThrottlerStorage) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60000,  // 1 minute window
            limit: config.get<number>('RATE_LIMIT_MAX', 100),
          },
          {
            name: 'burst',
            ttl: 1000,   // 1 second burst
            limit: config.get<number>('RATE_LIMIT_BURST_MAX', 10),
          },
        ],
        storage,
      }),
    }),

    // Event Emitter for Domain Events
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),

    // Scheduled Tasks (Outbox relay, etc.)
    ScheduleModule.forRoot(),

    // Health Checks
    TerminusModule,

    // Feature Modules
    MerchantModule,
    PaymentModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    // Global Rate Limiting Guard
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
