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
import { AuthModule } from '../../shared/auth/auth.module';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { VaultModule } from '../../shared/vault/vault.module';
import { KYCProviderPort } from './kyc-provider.port';
import { MockKYCProviderAdapter } from './mock-kyc-provider.adapter';
import { PersonaKycProviderAdapter } from './persona-kyc-provider.adapter';

@Module({
  imports: [TypeOrmModule.forFeature([MerchantEntity]), AuthModule, VaultModule],
  controllers: [AuthController, MerchantAdminController, KycWebhookController],
  providers: [
    MerchantService,
    MfaService,
    JwtAuthGuard,
    RolesGuard,
    KycWebhookGuard,
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
  ],
  exports: [MerchantService],
})
export class MerchantModule {}
