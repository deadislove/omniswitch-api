import 'dotenv/config';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { AppDataSource } from './data-source';
import { MerchantEntity } from '../modules/merchant/merchant.entity';
import { VaultTransitService } from '../shared/vault/vault-transit.service';

/**
 * Bootstraps the first ADMIN merchant on a brand-new deployment.
 *
 * `POST /admin/merchants` (the normal onboarding path) requires an existing
 * ADMIN JWT — correct for steady-state operation, but it means there is no
 * way to create the *first* merchant on a fresh database without already
 * having admin credentials. This script is the intentional escape hatch:
 * run once, by an operator with the same DB access `migration:run` already
 * requires, never wired into automatic container startup the way
 * migrations are.
 *
 * Deliberately NOT run automatically on every boot (unlike migrations):
 * this issues a new credential, which is a meaningfully different kind of
 * action than an idempotent schema change, and running it unattended on
 * every container start would mean a first-boot secret can end up baked
 * into aggregated container logs instead of an operator's own terminal.
 *
 * Idempotent: if an ADMIN merchant already exists, this is a no-op — safe
 * to run again by mistake, and safe if it happens to race a duplicate
 * merchant_id insert (handled below instead of crashing).
 */

const BCRYPT_ROUNDS = 12;

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

async function main(): Promise<void> {
  const merchantId = process.env.BOOTSTRAP_ADMIN_MERCHANT_ID || 'admin';
  const name = process.env.BOOTSTRAP_ADMIN_NAME || 'Bootstrap Admin';

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(MerchantEntity);

  // Standalone script, outside the Nest DI container (like AppDataSource
  // above) — constructed directly rather than injected.
  const vaultTransit = new VaultTransitService(new ConfigService());
  await vaultTransit.onModuleInit();

  try {
    const existingAdmin = await repo
      .createQueryBuilder('m')
      .where(`m.roles @> :role`, { role: JSON.stringify(['ADMIN']) })
      .getOne();

    if (existingAdmin) {
      console.log(
        `An ADMIN merchant already exists (merchantId=${existingAdmin.merchantId}, apiKeyId=${existingAdmin.apiKeyId}). Nothing to do.`,
      );
      return;
    }

    const apiKeySecret = randomToken('sk');
    const hmacSecret = randomBytes(32).toString('hex');
    const merchant = repo.create({
      id: randomUUID(),
      merchantId,
      name,
      apiKeyId: randomToken('ak'),
      apiKeySecretHash: await bcrypt.hash(apiKeySecret, BCRYPT_ROUNDS),
      hmacSecretCiphertext: await vaultTransit.encrypt(hmacSecret),
      roles: ['ADMIN'],
      isActive: true,
    });

    await repo.save(merchant);

    console.log('');
    console.log('=== Bootstrap ADMIN merchant created — save these now, they will not be shown again ===');
    console.log(`  merchantId:    ${merchant.merchantId}`);
    console.log(`  apiKeyId:      ${merchant.apiKeyId}`);
    console.log(`  apiKeySecret:  ${apiKeySecret}`);
    console.log(`  hmacSecret:    ${hmacSecret}`);
    console.log('===========================================================================');
    console.log('');
  } catch (err) {
    // Unique constraint on merchant_id — another process (or a previous,
    // interrupted run) already created this merchant. Treat as success:
    // the point of this script (an admin exists) is already satisfied.
    if (err instanceof QueryFailedError && /duplicate key|unique constraint/i.test(err.message)) {
      console.log(`Merchant ${merchantId} already exists (race with a concurrent run). Nothing to do.`);
      return;
    }
    throw err;
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error('Bootstrap admin seed failed:', err);
  process.exit(1);
});
