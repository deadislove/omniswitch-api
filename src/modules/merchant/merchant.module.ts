import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { MerchantEntity } from './merchant.entity';
import { MerchantService } from './merchant.service';
import { MfaService } from './mfa.service';
import { AuthController } from './auth.controller';
import { MerchantAdminController } from './merchant-admin.controller';
import { KycWebhookController } from './kyc-webhook.controller';
import { KycWebhookGuard } from './kyc-webhook.guard';
import { KybWebhookController } from './kyb-webhook.controller';
import { KybWebhookGuard } from './kyb-webhook.guard';
import { AuthModule } from '../../shared/auth/auth.module';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { VaultModule } from '../../shared/vault/vault.module';
import { KYCProviderPort } from './kyc-provider.port';
import { MockKYCProviderAdapter } from './mock-kyc-provider.adapter';
import { PersonaKycProviderAdapter } from './persona-kyc-provider.adapter';
import { KYBProviderPort } from './kyb-provider.port';
import { MockKYBProviderAdapter } from './mock-kyb-provider.adapter';
import { PersonaKybProviderAdapter } from './persona-kyb-provider.adapter';
import { SanctionsScreeningPort } from './sanctions-screening.port';
import { MockSanctionsScreeningAdapter } from './mock-sanctions-screening.adapter';
import { OfacSdnSanctionsAdapter } from './ofac-sdn-sanctions.adapter';
import { SanctionsListStore } from './sanctions/sanctions-list.store';
import { SanctionsListRefreshService } from './sanctions/sanctions-list-refresh.service';
import { SanctionsScreeningService } from './sanctions/sanctions-screening.service';
import { SanctionsScreeningSweepService } from './sanctions/sanctions-screening-sweep.service';
import { SanctionsAdminController } from './sanctions/sanctions-admin.controller';
import { SanctionsNotificationDispatcherService } from './sanctions/sanctions-notification-dispatcher.service';
import { SanctionsNotificationListener } from './sanctions/sanctions-notification.listener';
import { EmailSanctionsNotificationAdapter } from './sanctions/email-sanctions-notification.adapter';
import { SlackSanctionsNotificationAdapter } from './sanctions/slack-sanctions-notification.adapter';
import { WebhookSanctionsNotificationAdapter } from './sanctions/webhook-sanctions-notification.adapter';
import { WebhookDeliveryLogModule } from '../../shared/webhook-delivery-log/webhook-delivery-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([MerchantEntity]), AuthModule, VaultModule, WebhookDeliveryLogModule],
  controllers: [
    AuthController,
    MerchantAdminController,
    KycWebhookController,
    KybWebhookController,
    SanctionsAdminController,
  ],
  providers: [
    MerchantService,
    MfaService,
    JwtAuthGuard,
    RolesGuard,
    KycWebhookGuard,
    KybWebhookGuard,
    // Real adapter as an ordinary provider (its own ConfigService
    // dependency), then a useFactory picks which one KYCProviderPort
    // actually resolves to at DI-container build time —
    // KYC_PROVIDER ('mock' (default) / 'persona'). Same idiom
    // payment.module.ts uses for BankTransferPort/BANK_TRANSFER_PROVIDER.
    MockKYCProviderAdapter,
    PersonaKycProviderAdapter,
    {
      provide: KYCProviderPort,
      useFactory: (mock: MockKYCProviderAdapter, persona: PersonaKycProviderAdapter, config: ConfigService) => {
        const provider = config.get<string>('KYC_PROVIDER', 'mock');
        switch (provider) {
          case 'mock':
            return mock;
          case 'persona':
            return persona;
          default:
            throw new Error(`Unknown KYC_PROVIDER: "${provider}" (expected mock/persona)`);
        }
      },
      inject: [MockKYCProviderAdapter, PersonaKycProviderAdapter, ConfigService],
    },
    // Same useFactory idiom as KYCProviderPort/KYC_PROVIDER above —
    // KYB_PROVIDER ('mock' (default) / 'persona').
    MockKYBProviderAdapter,
    PersonaKybProviderAdapter,
    {
      provide: KYBProviderPort,
      useFactory: (mock: MockKYBProviderAdapter, persona: PersonaKybProviderAdapter, config: ConfigService) => {
        const provider = config.get<string>('KYB_PROVIDER', 'mock');
        switch (provider) {
          case 'mock':
            return mock;
          case 'persona':
            return persona;
          default:
            throw new Error(`Unknown KYB_PROVIDER: "${provider}" (expected mock/persona)`);
        }
      },
      inject: [MockKYBProviderAdapter, PersonaKybProviderAdapter, ConfigService],
    },
    // Same useFactory idiom as KYCProviderPort/KYC_PROVIDER above —
    // SANCTIONS_PROVIDER ('mock' (default) / 'ofac-self-hosted').
    SanctionsListStore,
    SanctionsListRefreshService,
    MockSanctionsScreeningAdapter,
    OfacSdnSanctionsAdapter,
    {
      provide: SanctionsScreeningPort,
      useFactory: (mock: MockSanctionsScreeningAdapter, ofac: OfacSdnSanctionsAdapter, config: ConfigService) => {
        const provider = config.get<string>('SANCTIONS_PROVIDER', 'mock');
        switch (provider) {
          case 'mock':
            return mock;
          case 'ofac-self-hosted':
            return ofac;
          default:
            throw new Error(`Unknown SANCTIONS_PROVIDER: "${provider}" (expected mock/ofac-self-hosted)`);
        }
      },
      inject: [MockSanctionsScreeningAdapter, OfacSdnSanctionsAdapter, ConfigService],
    },
    SanctionsScreeningService,
    SanctionsScreeningSweepService,
    EmailSanctionsNotificationAdapter,
    SlackSanctionsNotificationAdapter,
    WebhookSanctionsNotificationAdapter,
    SanctionsNotificationDispatcherService,
    SanctionsNotificationListener,
  ],
  exports: [MerchantService],
})
export class MerchantModule {}
