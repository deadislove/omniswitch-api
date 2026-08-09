import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { TokenRevocationService } from './token-revocation.service';

/**
 * Auth Module
 * Holds the JWT signing/verification wiring shared by both PaymentModule
 * (guards that verify incoming tokens) and MerchantModule (the /auth/token
 * endpoint that signs new ones). Factored out to avoid a circular import:
 * MerchantModule needs JwtService, and PaymentModule needs MerchantService
 * (for per-merchant HMAC secret lookup) — both can depend on this leaf
 * module without depending on each other.
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const jwtSecret = configService.get<string>('JWT_SECRET');
        if (!jwtSecret || jwtSecret.length < 32) {
          throw new Error(
            'JWT_SECRET must be set to a random value of at least 32 characters. Refusing to start with a missing/weak secret.',
          );
        }
        return {
          secret: jwtSecret,
          signOptions: { expiresIn: '1h', algorithm: 'HS256' },
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [JwtStrategy, TokenRevocationService],
  exports: [JwtModule, PassportModule, JwtStrategy, TokenRevocationService],
})
export class AuthModule {}
