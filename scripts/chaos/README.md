# Chaos scripts

See [`../../docs/technical/chaos-testing.md`](../../docs/technical/tests/chaos-testing.md)
for what each script proves and what running them actually found.

## Automated, scheduled runs

`../../.github/workflows/chaos-drill.yml` runs all three scenarios
monthly (and on-demand via `workflow_dispatch`) against a fresh
docker-compose stack the workflow brings up itself, using `run-drill.sh`
below — no manual seeding needed for that path. The rest of this file
covers running them by hand instead.

## Seeding credentials

None of these scripts create their own merchant — they need real,
already-seeded credentials, the same way `scripts/load-test/` does. There
is no bootstrap-from-nothing helper here (deliberately — see
`load-test/setup-merchants.js` for the equivalent that goes through the
real admin API instead of a one-off script like the snippet below).

Quickest path against a fresh `docker-compose up`, from the project root,
with the stack running (`api` built and up):

```bash
docker compose exec -T api node -e '
require("dotenv/config");
const { randomBytes, randomUUID } = require("crypto");
const bcrypt = require("bcryptjs");
const { ConfigService } = require("@nestjs/config");
const { AppDataSource } = require("./dist/database/data-source");
const { MerchantEntity } = require("./dist/modules/merchant/merchant.entity");
const { VaultTransitService } = require("./dist/shared/vault/vault-transit.service");
(async () => {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(MerchantEntity);
  const vault = new VaultTransitService(new ConfigService());
  await vault.onModuleInit();
  for (const [merchantId, roles] of [["chaos_merchant_1", ["MERCHANT"]], ["chaos_operator_1", ["OPERATOR"]]]) {
    const apiKeySecret = `sk_${randomBytes(24).toString("hex")}`;
    const hmacSecret = randomBytes(32).toString("hex");
    await repo.save(repo.create({
      id: randomUUID(), merchantId, name: merchantId,
      apiKeyId: `ak_${randomBytes(24).toString("hex")}`,
      apiKeySecretHash: await bcrypt.hash(apiKeySecret, 12),
      hmacSecretCiphertext: await vault.encrypt(hmacSecret),
      roles, isActive: true, platformFeeBps: 150,
    }));
    console.log(merchantId, JSON.stringify({ apiKeySecret, hmacSecret }));
  }
  await AppDataSource.destroy();
})();
'
```

Prints two lines (`apiKeyId` is on each saved `MerchantEntity`, read it
back with a `GET`/query, or capture it from the script's own `repo.create()`
return value if you adapt the snippet) — feed the values into the env
vars each chaos script's header documents.

## Running

```bash
MERCHANT_ID=chaos_merchant_1 \
MERCHANT_API_KEY_ID=... MERCHANT_API_KEY_SECRET=... MERCHANT_HMAC_SECRET=... \
OPERATOR_API_KEY_ID=... OPERATOR_API_KEY_SECRET=... \
bash scripts/chaos/psp-outage.sh

MERCHANT_API_KEY_ID=... MERCHANT_API_KEY_SECRET=... \
bash scripts/chaos/redis-outage.sh

MERCHANT_ID=chaos_merchant_1 \
MERCHANT_API_KEY_ID=... MERCHANT_API_KEY_SECRET=... MERCHANT_HMAC_SECRET=... \
bash scripts/chaos/postgres-primary-outage.sh
```

Each script stops and restarts a real container (`mock-psp`/`redis`/
`postgres-master`) via `docker compose`. Not destructive to data (all
three services keep their volumes across a stop/start), but do expect
brief real unavailability of whatever's targeted — don't run these
against anything other than a local dev stack.

`run-drill.sh` does the seeding step above and all three of these runs
for you — `bash scripts/chaos/run-drill.sh` against an already-up stack
(same one `chaos-drill.yml` uses) writes each scenario's full output plus
a `summary.md` into `./chaos-drill-output/` (override via `OUTPUT_DIR`)
and exits non-zero if any scenario failed.
