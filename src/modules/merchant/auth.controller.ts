import { Controller, Post, Body, Req, UseGuards, UnauthorizedException, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { IsString, MinLength, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { MerchantService } from './merchant.service';
import { MfaService } from './mfa.service';
import { Public } from '../../shared/decorators/public.decorator';
import { AllowMfaPending } from '../../shared/decorators/allow-mfa-pending.decorator';
import { JwtPayload } from '../../shared/auth/jwt.strategy';
import { TokenRevocationService } from '../../shared/auth/token-revocation.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';

const MFA_PENDING_TOKEN_TTL_SECONDS = 300;
const FULL_TOKEN_TTL_SECONDS = 3600;

export class TokenRequestDto {
  @ApiProperty({ example: 'ak_live_...', description: 'API Key ID (public identifier)' })
  @IsString()
  @MinLength(1)
  apiKeyId: string;

  @ApiProperty({ example: 'sk_live_...', description: 'API Key Secret' })
  @IsString()
  @MinLength(1)
  apiKeySecret: string;
}

export class TokenResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ example: 3600, description: 'Seconds until the token expires' })
  expiresIn: number;

  @ApiPropertyOptional({
    description: 'If true, accessToken is a short-lived, restricted token only usable against POST /auth/mfa/verify — this merchant has MFA enabled.',
  })
  mfaRequired?: boolean;
}

export class MfaCodeDto {
  @ApiProperty({ example: '123456', description: 'A current TOTP code, or an unused backup code (XXXX-XXXX)' })
  @IsString()
  @Length(6, 9)
  code: string;
}

export class MfaEnrollResponseDto {
  @ApiProperty({ description: 'Base32 TOTP secret — shown once, also encoded in otpauthUrl' })
  secret: string;

  @ApiProperty({ description: 'otpauth:// URI — render as a QR code for an authenticator app to scan' })
  otpauthUrl: string;
}

export class MfaConfirmResponseDto {
  @ApiProperty({ type: [String], description: 'Single-use recovery codes — shown once, store them now' })
  backupCodes: string[];
}

export class RevokeTokenResponseDto {
  @ApiProperty({ example: true })
  revoked: boolean;
}

export class DisableMfaResponseDto {
  @ApiProperty({ example: true })
  disabled: boolean;
}

/**
 * Auth Controller
 * Machine-to-machine login: exchanges an API Key ID + Secret for a
 * short-lived JWT usable against every other endpoint's JwtAuthGuard.
 * Without this, nothing could ever obtain a valid token to call the API.
 *
 * MFA (TOTP, PCI DSS Req 8.4.2) is opt-in per merchant — see
 * docs/technical/security-and-compliance.md's MFA section for why this
 * isn't mandated for any specific role here. Once a merchant enables it,
 * POST /auth/token stops returning a directly-usable token for them: it
 * returns a short-lived, restricted one that only POST /auth/mfa/verify
 * will accept (JwtAuthGuard rejects it everywhere else — see that guard's
 * docblock).
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly merchantService: MerchantService,
    private readonly mfaService: MfaService,
    private readonly jwtService: JwtService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {}

  @Post('token')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Aggressive rate limit — this endpoint is a credential-guessing target.
  // Configurable (env var, read at module-load time — decorator arguments
  // can't use DI) rather than hardcoded so a legitimate high-volume caller
  // (or an e2e suite that logs in many times per run) isn't forced to use
  // the same limit as the production default.
  @Throttle({ default: { limit: Number(process.env.AUTH_LOGIN_RATE_LIMIT) || 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Exchange an API Key ID + Secret for a JWT (or, if MFA is enabled, a short-lived pending token)' })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid API credentials' })
  async issueToken(@Body() dto: TokenRequestDto): Promise<TokenResponseDto> {
    const merchant = await this.merchantService.verifyCredentials(dto.apiKeyId, dto.apiKeySecret);
    if (!merchant) {
      // Same message regardless of which credential was wrong — don't leak
      // whether the apiKeyId even exists.
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Invalid API credentials',
        code: 'INVALID_CREDENTIALS',
      });
    }

    if (merchant.mfaEnabled) {
      const payload: JwtPayload = {
        sub: merchant.id,
        merchantId: merchant.merchantId,
        roles: merchant.roles as JwtPayload['roles'],
        jti: randomUUID(),
        mfaPending: true,
      };
      return {
        accessToken: this.jwtService.sign(payload, { expiresIn: MFA_PENDING_TOKEN_TTL_SECONDS }),
        tokenType: 'Bearer',
        expiresIn: MFA_PENDING_TOKEN_TTL_SECONDS,
        mfaRequired: true,
      };
    }

    const payload: JwtPayload = {
      sub: merchant.id,
      merchantId: merchant.merchantId,
      roles: merchant.roles as JwtPayload['roles'],
      jti: randomUUID(),
    };

    return {
      accessToken: this.jwtService.sign(payload),
      tokenType: 'Bearer',
      expiresIn: FULL_TOKEN_TTL_SECONDS,
    };
  }

  @Post('revoke')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the current access token (logout) — takes effect immediately' })
  @ApiResponse({ status: 200, type: RevokeTokenResponseDto })
  async revokeCurrentToken(@Req() req: any): Promise<RevokeTokenResponseDto> {
    const jti: string | undefined = req.user?.jti;
    const exp: number | undefined = req.user?.tokenExp;
    if (jti && exp) {
      const remainingSeconds = exp - Math.floor(Date.now() / 1000);
      await this.tokenRevocation.revokeToken(jti, remainingSeconds);
    }
    return { revoked: true };
  }

  @Post('mfa/enroll')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start MFA enrollment — generates a TOTP secret (not yet enforced until confirmed)' })
  @ApiResponse({ status: 200, type: MfaEnrollResponseDto })
  @ApiResponse({ status: 409, description: 'MFA is already enabled for this merchant' })
  async enrollMfa(@Req() req: any): Promise<MfaEnrollResponseDto> {
    return this.mfaService.generateEnrollment(req.user.merchantId);
  }

  @Post('mfa/confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm MFA enrollment with a TOTP code — enables MFA and returns one-time backup codes' })
  @ApiResponse({ status: 200, type: MfaConfirmResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid TOTP code' })
  @ApiResponse({ status: 409, description: 'No enrollment in progress (call POST /auth/mfa/enroll first)' })
  async confirmMfa(@Req() req: any, @Body() dto: MfaCodeDto): Promise<MfaConfirmResponseDto> {
    return this.mfaService.confirmEnrollment(req.user.merchantId, dto.code);
  }

  @Post('mfa/disable')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable MFA — requires a valid TOTP/backup code, so a stolen JWT alone can\'t turn it off' })
  @ApiResponse({ status: 200, type: DisableMfaResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid TOTP/backup code' })
  @ApiResponse({ status: 409, description: 'MFA is not enabled' })
  async disableMfa(@Req() req: any, @Body() dto: MfaCodeDto): Promise<DisableMfaResponseDto> {
    await this.mfaService.disableMfa(req.user.merchantId, dto.code);
    return { disabled: true };
  }

  @Post('mfa/verify')
  @UseGuards(JwtAuthGuard)
  @AllowMfaPending()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trade a pending MFA token for a full one by proving a valid TOTP/backup code' })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid TOTP/backup code' })
  @ApiResponse({ status: 409, description: 'MFA is not enabled for this merchant' })
  async verifyMfa(@Req() req: any, @Body() dto: MfaCodeDto): Promise<TokenResponseDto> {
    await this.mfaService.verifyCode(req.user.merchantId, dto.code);

    // The pending token did its job — kill it so it can't be replayed even
    // though it would have expired in minutes anyway (defense in depth,
    // same idea as revoking on logout).
    if (req.user.jti && req.user.tokenExp) {
      const remainingSeconds = req.user.tokenExp - Math.floor(Date.now() / 1000);
      await this.tokenRevocation.revokeToken(req.user.jti, remainingSeconds);
    }

    const payload: JwtPayload = {
      sub: req.user.userId,
      merchantId: req.user.merchantId,
      roles: req.user.roles,
      jti: randomUUID(),
    };

    return {
      accessToken: this.jwtService.sign(payload),
      tokenType: 'Bearer',
      expiresIn: FULL_TOKEN_TTL_SECONDS,
    };
  }
}
