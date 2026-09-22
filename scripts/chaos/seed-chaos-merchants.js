// Seeds the two merchants the chaos scripts need (one MERCHANT-role, one
// OPERATOR-role — see scripts/chaos/README.md for why a bootstrap-from-nothing
// helper doesn't already exist elsewhere). Meant to be piped into the running
// `api` container's own `node`, e.g.:
//
//   cat scripts/chaos/seed-chaos-merchants.js | docker compose exec -T api node
//
// so it runs against the container's own already-built dist/ and already-
// configured Vault/DB env, the same way scripts/chaos/README.md's manual
// snippet does — this just replaces that snippet with a reusable, parseable
// version. Prints `export VAR=...` lines to stdout ONLY (safe to `eval`
// directly); everything else goes to stderr, so a caller can do:
//
//   eval "$(cat scripts/chaos/seed-chaos-merchants.js | docker compose exec -T api node)"
require('dotenv/config');
const { randomBytes, randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { ConfigService } = require('@nestjs/config');
// VaultTransitService (like most of this codebase) logs through Nest's
// built-in Logger, which writes LOG-level output to stdout — fine for the
// app itself, but this script's stdout is meant to be eval'd directly by
// its caller, so any stray line here would break that. Silence it before
// constructing anything that logs.
require('@nestjs/common').Logger.overrideLogger(false);
const { AppDataSource } = require('./dist/database/data-source');
const { MerchantEntity } = require('./dist/modules/merchant/merchant.entity');
const { VaultTransitService } = require('./dist/shared/vault/vault-transit.service');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

(async () => {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(MerchantEntity);
  const vault = new VaultTransitService(new ConfigService());
  await vault.onModuleInit();

  const exports = {};
  for (const [envPrefix, merchantId, roles] of [
    ['MERCHANT', 'chaos_merchant_drill', ['MERCHANT']],
    ['OPERATOR', 'chaos_operator_drill', ['OPERATOR']],
  ]) {
    const apiKeySecret = `sk_${randomBytes(24).toString('hex')}`;
    const hmacSecret = randomBytes(32).toString('hex');
    const apiKeyId = `ak_${randomBytes(24).toString('hex')}`;
    // Re-run-safe against a persistent DB (e.g. a local manual run), not
    // just the fresh-each-time ephemeral DB the scheduled workflow uses.
    await repo.delete({ merchantId });
    await repo.save(
      repo.create({
        id: randomUUID(),
        merchantId,
        name: merchantId,
        apiKeyId,
        apiKeySecretHash: await bcrypt.hash(apiKeySecret, 12),
        hmacSecretCiphertext: await vault.encrypt(hmacSecret),
        roles,
        isActive: true,
        platformFeeBps: 150,
      }),
    );
    console.error(`Seeded ${merchantId} (${roles.join(',')})`);
    if (envPrefix === 'MERCHANT') {
      exports.MERCHANT_ID = merchantId;
    }
    exports[`${envPrefix}_API_KEY_ID`] = apiKeyId;
    exports[`${envPrefix}_API_KEY_SECRET`] = apiKeySecret;
    if (envPrefix === 'MERCHANT') {
      exports.MERCHANT_HMAC_SECRET = hmacSecret;
    }
  }

  await AppDataSource.destroy();

  for (const [key, value] of Object.entries(exports)) {
    console.log(`export ${key}=${shellQuote(value)}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
