import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MerchantEntity } from './merchant.entity';
import { MerchantService } from './merchant.service';
import { MfaService } from './mfa.service';
import { AuthController } from './auth.controller';
import { MerchantAdminController } from './merchant-admin.controller';
import { AuthModule } from '../../shared/auth/auth.module';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { VaultModule } from '../../shared/vault/vault.module';
import { KYCProviderPort } from './kyc-provider.port';
import { MockKYCProviderAdapter } from './mock-kyc-provider.adapter';

@Module({
  imports: [TypeOrmModule.forFeature([MerchantEntity]), AuthModule, VaultModule],
  controllers: [AuthController, MerchantAdminController],
  providers: [
    MerchantService,
    MfaService,
    JwtAuthGuard,
    RolesGuard,
    { provide: KYCProviderPort, useClass: MockKYCProviderAdapter },
  ],
  exports: [MerchantService],
})
export class MerchantModule {}
