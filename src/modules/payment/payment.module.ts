import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

// Entities
import { PaymentEntity } from './adapters/persistence/entities/payment.entity';
import { LedgerOutboxEntity } from './adapters/persistence/entities/ledger-outbox.entity';
import { ReconciliationRunEntity } from './adapters/persistence/entities/reconciliation-run.entity';
import { DisputeEntity } from './adapters/persistence/entities/dispute.entity';
import { ReserveHoldEntity } from './adapters/persistence/entities/reserve-hold.entity';
import { SubscriptionEntity } from './adapters/persistence/entities/subscription.entity';
import { PlanEntity } from './adapters/persistence/entities/plan.entity';
import { PayoutEntity } from './adapters/persistence/entities/payout.entity';
import { PayoutSweepRunEntity } from './adapters/persistence/entities/payout-sweep-run.entity';
import { DelegationEntity } from './adapters/persistence/entities/delegation.entity';

// Repositories
import { PaymentTypeOrmRepository, LedgerOutboxTypeOrmRepository } from './adapters/persistence/repositories/payment-typeorm.repository';
import { ReconciliationTypeOrmRepository } from './adapters/persistence/repositories/reconciliation-typeorm.repository';
import { DisputeTypeOrmRepository } from './adapters/persistence/repositories/dispute-typeorm.repository';
import { ReserveHoldTypeOrmRepository } from './adapters/persistence/repositories/reserve-hold-typeorm.repository';
import { SubscriptionTypeOrmRepository } from './adapters/persistence/repositories/subscription-typeorm.repository';
import { PlanTypeOrmRepository } from './adapters/persistence/repositories/plan-typeorm.repository';
import { PayoutTypeOrmRepository } from './adapters/persistence/repositories/payout-typeorm.repository';
import { MockBankTransferAdapter } from './adapters/bank/mock-bank-transfer.adapter';
import { DelegationTypeOrmRepository } from './adapters/persistence/repositories/delegation-typeorm.repository';

// Ports
import { PaymentRepositoryPort } from './ports/outbound/payment-repository.port';
import { LedgerOutboxPort } from './ports/outbound/ledger-outbox.port';
import { CachePort } from './ports/outbound/cache.port';
import { ReconciliationPort } from './ports/outbound/reconciliation.port';
import { DisputePort } from './ports/outbound/dispute.port';
import { FXRateProviderPort } from './ports/outbound/fx-rate-provider.port';
import { ReserveHoldPort } from './ports/outbound/reserve-hold.port';
import { SubscriptionPort } from './ports/outbound/subscription.port';
import { PlanPort } from './ports/outbound/plan.port';
import { PayoutPort } from './ports/outbound/payout.port';
import { BankTransferPort } from './ports/outbound/bank-transfer.port';
import { DelegationPort } from './ports/outbound/delegation.port';

// Adapters
import { RedisCacheAdapter } from './adapters/cache/redis-cache.adapter';
import { StripePSPAdapter } from './adapters/psp/stripe/stripe-psp.adapter';
import { AdyenPSPAdapter } from './adapters/psp/adyen/adyen-psp.adapter';
import { PaymentProcessorFactory } from './adapters/psp/payment-processor.factory';
import { RedisCircuitBreakerService } from './adapters/circuit-breaker/redis-circuit-breaker.service';
import { FXRateProviderAdapter } from './adapters/fx/fx-rate-provider.adapter';

// Application Services
import { AcquirerRoutingService } from './application/services/acquirer-routing.service';
import { PaymentCheckoutSaga } from './application/sagas/payment-checkout.saga';
import { IdempotencyInterceptor } from './application/interceptors/idempotency.interceptor';
import { WebhookProcessingService } from './application/services/webhook-processing.service';
import { PaymentLifecycleService } from './application/services/payment-lifecycle.service';
import { LedgerOutboxRelayService } from './application/services/ledger-outbox-relay.service';
import { OutboxRecoveryService } from './application/services/outbox-recovery.service';
import { ReconciliationService } from './application/services/reconciliation.service';
import { DisputeService } from './application/services/dispute.service';
import { ChargeLedgerParamsResolverService } from './application/services/charge-ledger-params-resolver.service';
import { ReserveService } from './application/services/reserve.service';
import { SubscriptionService } from './application/services/subscription.service';
import { RiskTieringService } from './application/services/risk-tiering.service';
import { PlanService } from './application/services/plan.service';
import { PayoutService } from './application/services/payout.service';
import { DelegationService } from './application/services/delegation.service';

// Controller
import { PaymentController } from './application/controllers/payment.controller';
import { WebhookController } from './application/controllers/webhook.controller';
import { OutboxAdminController } from './application/controllers/outbox-admin.controller';
import { ReconciliationAdminController } from './application/controllers/reconciliation-admin.controller';
import { DisputeAdminController } from './application/controllers/dispute-admin.controller';
import { ReserveAdminController } from './application/controllers/reserve-admin.controller';
import { SubscriptionController } from './application/controllers/subscription.controller';
import { SubscriptionAdminController } from './application/controllers/subscription-admin.controller';
import { RiskTieringAdminController } from './application/controllers/risk-tiering-admin.controller';
import { PlanController } from './application/controllers/plan.controller';
import { MarketplacePayoutAdminController } from './application/controllers/marketplace-payout-admin.controller';
import { DelegationController } from './application/controllers/delegation.controller';

// Webhook Guards
import { StripeWebhookGuard } from './adapters/psp/stripe/stripe-webhook.guard';
import { AdyenWebhookGuard } from './adapters/psp/adyen/adyen-webhook.guard';

// Shared
import { AuthModule } from '../../shared/auth/auth.module';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { HmacSignatureGuard } from '../../shared/guards/hmac-signature.guard';
import { MerchantThrottlerGuard } from '../../shared/guards/merchant-throttler.guard';

// Merchant (per-merchant HMAC secret lookup)
import { MerchantModule } from '../merchant/merchant.module';
import { VaultModule } from '../../shared/vault/vault.module';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    MerchantModule,
    VaultModule,
    TypeOrmModule.forFeature([PaymentEntity, LedgerOutboxEntity, ReconciliationRunEntity, DisputeEntity, ReserveHoldEntity, SubscriptionEntity, PlanEntity, PayoutEntity, PayoutSweepRunEntity, DelegationEntity]),
    // No separate ThrottlerModule registration here: @nestjs/throttler's
    // ThrottlerModule is @Global(), so there is exactly one
    // ThrottlerStorageService/THROTTLER_OPTIONS for the whole app regardless
    // of how many modules call forRoot/forRootAsync — a second registration
    // doesn't get MerchantThrottlerGuard its own counters, it just resolves
    // to the same global one (confirmed live: a supposedly-independent
    // "burst limit=5" registration here was silently ignored in favor of
    // AppModule's limit=10). MerchantThrottlerGuard reuses the same
    // 'default'/'burst' tiers as the global IP-keyed guard; they stay
    // independent per-merchant vs per-IP anyway because ThrottlerGuard's
    // generateKey() hashes the tracker value into the storage key.
    //
    // No EventEmitterModule.forRoot() here either, and this one is NOT the
    // same "silently resolves to the global one" story as Throttler above —
    // @nestjs/event-emitter's forRoot() does `useValue: new EventEmitter2(...)`
    // on *every* call, so a second forRoot() (this module used to have one)
    // doesn't harmlessly collapse into app.module.ts's — it creates a
    // genuinely separate EventEmitter2 instance, silently splitting the
    // app's event bus in two. Confirmed live: an e2e test listening via
    // `app.get(EventEmitter2)` (resolving to AppModule's instance) never
    // received events DisputeService emitted (resolving to this module's
    // instance) — 0 received, not a timing flake. AppModule's registration
    // already covers the whole app via @Global(); this one was pure
    // duplication that happened to be actively harmful, not just redundant.
  ],
  controllers: [PaymentController, WebhookController, OutboxAdminController, ReconciliationAdminController, DisputeAdminController, ReserveAdminController, SubscriptionController, SubscriptionAdminController, RiskTieringAdminController, PlanController, MarketplacePayoutAdminController, DelegationController],
  providers: [
    // PSP Adapters
    StripePSPAdapter,
    AdyenPSPAdapter,
    PaymentProcessorFactory,
    RedisCircuitBreakerService,

    // Cache Adapter
    RedisCacheAdapter,

    // Port bindings (abstract -> concrete)
    {
      provide: PaymentRepositoryPort,
      useClass: PaymentTypeOrmRepository,
    },
    {
      provide: LedgerOutboxPort,
      useClass: LedgerOutboxTypeOrmRepository,
    },
    {
      provide: CachePort,
      useClass: RedisCacheAdapter,
    },
    {
      provide: ReconciliationPort,
      useClass: ReconciliationTypeOrmRepository,
    },
    {
      provide: DisputePort,
      useClass: DisputeTypeOrmRepository,
    },
    {
      provide: FXRateProviderPort,
      useClass: FXRateProviderAdapter,
    },
    {
      provide: ReserveHoldPort,
      useClass: ReserveHoldTypeOrmRepository,
    },
    {
      provide: SubscriptionPort,
      useClass: SubscriptionTypeOrmRepository,
    },
    {
      provide: PlanPort,
      useClass: PlanTypeOrmRepository,
    },
    {
      provide: PayoutPort,
      useClass: PayoutTypeOrmRepository,
    },
    {
      provide: BankTransferPort,
      useClass: MockBankTransferAdapter,
    },
    {
      provide: DelegationPort,
      useClass: DelegationTypeOrmRepository,
    },

    // Application Services
    AcquirerRoutingService,
    PaymentCheckoutSaga,
    IdempotencyInterceptor,
    WebhookProcessingService,
    PaymentLifecycleService,
    LedgerOutboxRelayService,
    OutboxRecoveryService,
    ReconciliationService,
    DisputeService,
    ChargeLedgerParamsResolverService,
    ReserveService,
    SubscriptionService,
    RiskTieringService,
    PlanService,
    PayoutService,
    DelegationService,

    // Auth
    JwtAuthGuard,
    RolesGuard,
    HmacSignatureGuard,
    MerchantThrottlerGuard,

    // Webhook signature guards
    StripeWebhookGuard,
    AdyenWebhookGuard,
  ],
  exports: [
    PaymentRepositoryPort,
    AcquirerRoutingService,
    PaymentProcessorFactory,
    CachePort,
    LedgerOutboxPort,
  ],
})
export class PaymentModule {}
