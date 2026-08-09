import { Injectable, Logger, ConflictException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { authenticator } from 'otplib';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { MerchantEntity } from './merchant.entity';
import { VaultTransitService } from '../../shared/vault/vault-transit.service';

const BCRYPT_ROUNDS = 12;
const BACKUP_CODE_COUNT = 10;
const ISSUER = 'OmniSwitch';

/**
 * MFA Service
 * TOTP-based second factor for merchant login — closes the PCI DSS Req
 * 8.4.2 gap noted in docs/technical/security-and-compliance.md ("not
 * implemented anywhere"). Opt-in per merchant, not mandatory for any role
 * — see that doc's MFA section for why mandating it for ADMIN specifically
 * is a separate, still-open policy decision, not an engineering one.
 *
 * The TOTP secret is envelope-encrypted via the same VaultTransitService
 * `hmacSecretCiphertext` uses (Vault Transit encryption doesn't care what
 * plaintext it's given — reusing the key is a deliberate simplification,
 * not a naming accident). Backup codes are bcrypt-hashed, same posture as
 * `apiKeySecretHash` — this app never has the plaintext of an unused
 * backup code once enrollment finishes.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @InjectRepository(MerchantEntity)
    private readonly merchantRepo: Repository<MerchantEntity>,
    private readonly vaultTransit: VaultTransitService,
  ) {}

  /**
   * Starts enrollment: generates a new TOTP secret and stores it
   * encrypted, but does NOT enable MFA yet — confirmEnrollment() has to
   * prove the merchant actually captured it correctly first. Calling this
   * again before confirming just overwrites the pending secret (the old
   * unconfirmed one was never enforcing anything).
   */
  async generateEnrollment(merchantId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const merchant = await this.getOrThrow(merchantId);
    if (merchant.mfaEnabled) {
      throw new ConflictException({
        statusCode: 409,
        error: 'MFA is already enabled — disable it before re-enrolling',
        code: 'MFA_ALREADY_ENABLED',
      });
    }

    const secret = authenticator.generateSecret();
    merchant.mfaSecretCiphertext = await this.vaultTransit.encrypt(secret);
    await this.merchantRepo.save(merchant);

    const otpauthUrl = authenticator.keyuri(merchantId, ISSUER, secret);
    this.logger.log(`MFA enrollment started for merchant ${merchantId}`);
    return { secret, otpauthUrl };
  }

  /**
   * Completes enrollment: the merchant proves they captured the secret
   * correctly by producing a valid code from it. Only on success does MFA
   * actually start being enforced at login — issues a fresh set of backup
   * codes (plaintext returned once, exactly like apiKeySecret/hmacSecret
   * at merchant creation).
   */
  async confirmEnrollment(merchantId: string, code: string): Promise<{ backupCodes: string[] }> {
    const merchant = await this.getOrThrow(merchantId);
    if (!merchant.mfaSecretCiphertext) {
      throw new ConflictException({
        statusCode: 409,
        error: 'No MFA enrollment in progress — call POST /auth/mfa/enroll first',
        code: 'MFA_NOT_ENROLLING',
      });
    }

    const secret = await this.vaultTransit.decrypt(merchant.mfaSecretCiphertext);
    if (!authenticator.check(code, secret)) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Invalid MFA code',
        code: 'MFA_CODE_INVALID',
      });
    }

    const { plaintextCodes, hashes } = await this.generateBackupCodes();
    merchant.mfaEnabled = true;
    merchant.mfaBackupCodeHashes = hashes;
    await this.merchantRepo.save(merchant);

    this.logger.log(`MFA enabled for merchant ${merchantId}`);
    return { backupCodes: plaintextCodes };
  }

  /**
   * Verifies a TOTP or backup code — used by both POST /auth/mfa/verify
   * (trading a pending token for a full one) and disableMfa() (proving you
   * still control the second factor before turning it off). A backup code
   * is single-use: consumed (removed from the stored hash list) on
   * success, not just checked.
   */
  async verifyCode(merchantId: string, code: string): Promise<void> {
    const merchant = await this.getOrThrow(merchantId);
    if (!merchant.mfaEnabled || !merchant.mfaSecretCiphertext) {
      throw new ConflictException({
        statusCode: 409,
        error: 'MFA is not enabled for this merchant',
        code: 'MFA_NOT_ENABLED',
      });
    }

    const secret = await this.vaultTransit.decrypt(merchant.mfaSecretCiphertext);
    if (authenticator.check(code, secret)) {
      return;
    }

    // Not a valid TOTP code — check it against remaining backup codes.
    // Each hash has to be checked individually (bcrypt hashes aren't
    // directly comparable/searchable), same as any bcrypt-based lookup.
    for (let i = 0; i < merchant.mfaBackupCodeHashes.length; i++) {
      if (await bcrypt.compare(code, merchant.mfaBackupCodeHashes[i])) {
        merchant.mfaBackupCodeHashes = merchant.mfaBackupCodeHashes.filter((_, idx) => idx !== i);
        await this.merchantRepo.save(merchant);
        this.logger.warn(`Merchant ${merchantId} used a backup code — ${merchant.mfaBackupCodeHashes.length} remaining`);
        return;
      }
    }

    throw new UnauthorizedException({
      statusCode: 401,
      error: 'Invalid MFA code',
      code: 'MFA_CODE_INVALID',
    });
  }

  /** Requires a valid code first — an attacker with just a stolen JWT can't silently turn MFA off. */
  async disableMfa(merchantId: string, code: string): Promise<void> {
    await this.verifyCode(merchantId, code);
    const merchant = await this.getOrThrow(merchantId);
    merchant.mfaEnabled = false;
    // null, not undefined — TypeORM's save() silently skips an undefined
    // property instead of writing SQL NULL, which would leave the old
    // encrypted secret sitting in the database despite "disable" appearing
    // to succeed (same pattern as MerchantService.updateSettlementCurrency()).
    // Harmless on its own (mfaEnabled gates the login flow regardless, and
    // the value was always ciphertext, never plaintext) but real stale-data
    // hygiene the "disable" action should actually deliver.
    merchant.mfaSecretCiphertext = null;
    merchant.mfaBackupCodeHashes = [];
    await this.merchantRepo.save(merchant);
    this.logger.warn(`MFA disabled for merchant ${merchantId}`);
  }

  private async generateBackupCodes(): Promise<{ plaintextCodes: string[]; hashes: string[] }> {
    const plaintextCodes: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      // XXXX-XXXX, uppercase hex — easy to read back/type once, printed once.
      const code = randomBytes(4).toString('hex').toUpperCase();
      const formatted = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
      plaintextCodes.push(formatted);
      hashes.push(await bcrypt.hash(formatted, BCRYPT_ROUNDS));
    }
    return { plaintextCodes, hashes };
  }

  private async getOrThrow(merchantId: string): Promise<MerchantEntity> {
    const merchant = await this.merchantRepo.findOne({ where: { merchantId } });
    if (!merchant) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Merchant ${merchantId} not found`,
        code: 'MERCHANT_NOT_FOUND',
      });
    }
    return merchant;
  }
}
