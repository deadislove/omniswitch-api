# The Application: Deployment, Service, Scaling, Configuration

## `deployment.yaml`

3 replicas by default (`hpa.yaml` scales 3–20), `RollingUpdate` with
`maxSurge: 1`/`maxUnavailable: 0` for zero-downtime rollouts, and
pod anti-affinity (`preferredDuringSchedulingIgnoredDuringExecution`,
soft not hard) spreading replicas across nodes by hostname. Runs as
non-root (`runAsUser: 1001`, `runAsGroup: 1001`, `fsGroup: 1001`) with
`allowPrivilegeEscalation: false` and every Linux capability dropped —
this app's own code needs none of them, unlike `vault.yaml`/
`pgbouncer.yaml` in the data layer, which each have a documented reason
their containers can't run under the same restriction (see
[`data-layer.md`](./data-layer.md)). Resource requests/limits are
`250m`/`256Mi` and `1000m`/`512Mi` — see
[`../load-testing.md`](../load-testing.md) for what these are based on
and where the reframing math against real measured usage lives.

Three probes, all against `/health/live` or `/health/ready`:
`startupProbe` (12 × 5s = 60s max boot time before the other two probes
even start checking), `livenessProbe` (30s initial delay, 15s period),
`readinessProbe` (20s initial delay, 10s period).

Every environment variable is sourced from `configmap.yaml` or
`omniswitch-secrets` via `configMapKeyRef`/`secretKeyRef` — none are
inlined here. Five of these are worth knowing about specifically,
because getting any of them wrong fails in a way that isn't obvious from
`kubectl apply` succeeding:

- **`DB_MASTER_PORT`/`DB_REPLICA_PORT`** — `app.module.ts` defaults
  these independently if unset: `DB_MASTER_PORT` to `5432` (usually
  correct by coincidence) but `DB_REPLICA_PORT` to `5433` (almost never
  correct, since `5432` is the standard port everyone actually uses).
  Omitting `DB_REPLICA_PORT` means every replica connection attempt
  hits a port nothing is listening on — an immediate refusal, not a slow
  timeout — which fails `DataSource.initialize()` as a whole (TypeORM's
  `replication` mode treats master+replica startup as one unit) and
  prevents the application from booting at all. Confirmed as the root
  cause of a real, deterministic boot failure.
- **`DB_SSL`** — without this, `app.module.ts`'s `config.get('DB_SSL')`
  reads as unset and silently falls back to `ssl: false` even though
  `configmap.yaml`'s own `DB_SSL` value is `"true"` — TLS to the
  database would be silently disabled, not fail loudly.
- **`VAULT_ADDR`/`VAULT_TOKEN`** — without these, `VaultTransitService`
  falls back to `http://localhost:8200` with an empty token.
  `HmacSignatureGuard` calls it on every HMAC-signed request (charge,
  refund, capture, cancel, dispute-evidence) — this is on the
  money-moving hot path, not just a boot-time nicety.

## `service.yaml`

`ClusterIP`, `port: 80` → `targetPort: 3000`. The distinction between
the Service's exposed port and the pod's container port matters more
than it looks: anything connecting via the Service's DNS name
(`omniswitch-api.payments.svc.cluster.local`) must use port `80`, not
`3000` — connecting to the Service's ClusterIP on `3000` finds no
matching `kube-proxy` DNAT rule and simply times out, silently, with no
error pointing at the actual mismatch.
`ingress.yaml`'s backend `port.number: 80` already gets this right.

## `hpa.yaml`

`minReplicas: 3`, `maxReplicas: 20`, scaling on CPU > 70% or memory >
80% utilization (whichever triggers first). Scale-up is fast and
aggressive (60s stabilization window, up to +50% of current replicas or
+2 pods per 60s, whichever is larger) — deliberately biased toward
over-provisioning briefly rather than under-provisioning during a real
traffic spike. Scale-down is slow and conservative (5-minute
stabilization window, at most 1 pod removed per 120s) — avoids
flapping capacity down right before the next spike.

## `configmap.yaml`

Non-secret configuration, organized by concern:

- **Database** — `DB_MASTER_HOST`/`DB_REPLICA_HOST` point at the
  PgBouncer poolers (`pgbouncer-master`/`pgbouncer-replica`), not
  directly at Postgres; `PGBOUNCER_MASTER_BACKEND_HOST`/
  `PGBOUNCER_REPLICA_BACKEND_HOST` are what the poolers themselves
  connect to. See [`data-layer.md`](./data-layer.md) for why the
  pooler exists.
- **Redis** — host/port/db index, no password (that's in
  `omniswitch-secrets`).
- **Rate limiting** — `RATE_LIMIT_MAX`/`RATE_LIMIT_TTL`, the global
  per-merchant limiter; route-specific overrides
  (`CHARGE_RATE_LIMIT_MAX`, `AUTH_LOGIN_RATE_LIMIT`) are set at the
  controller level in code, not here.
- **Data retention** — `ARCHIVE_THRESHOLD_DAYS`,
  `DELETION_THRESHOLD_YEARS`, `DELETION_BACKUP_*`,
  `CUTOVER_OLD_TABLE_RETENTION_DAYS`, `PARTITION_MAINTENANCE_MONTHS_AHEAD`
  — see [`../../compliance/data-retention.md`](../../compliance/data-retention.md)
  for the full policy these implement and
  [`../jobs.md`](../jobs.md) for the jobs that read them.
- **PSP configuration** — `ADYEN_BASE_URL` points at the real
  `checkout-live.adyen.com`; `STRIPE_BASE_URL` is deliberately absent
  (the adapter defaults to the real Stripe API when unset).
  `FX_RATE_PROVIDER_URL`/`KYC_PROVIDER_URL`/`BANK_TRANSFER_PROVIDER_URL`
  are also absent — their adapters are literally named
  `FXRateProviderAdapter`/`MockKycProviderAdapter`/
  `MockBankTransferAdapter`, with no real third-party integration behind
  any of them yet. Leaving them unset (rather than pointing at a
  realistic-looking URL) is the honest state until a real provider is
  integrated. See
  [`../deployment/charge-latency-test-environment.md`](../deployment/charge-latency-test-environment.md)
  for how to temporarily redirect these at a mock PSP for testing,
  without editing this file.
- **Vault** — `VAULT_ADDR` only; `VAULT_TOKEN` is a credential and
  lives in `omniswitch-secrets` instead.

## `secret.yaml`

Every value is a base64-encoded placeholder (`CHANGE_ME_*`), documented
inline with what the decoded plaintext is. Not meant to be applied
as-is against anything real — see
[`../secret-management.md`](../secret-management.md) for the
Vault-Transit design this backs, and
`external-secrets-example.yaml` (next) for the realistic production
alternative to hand-editing this file's base64 values.

## `external-secrets-example.yaml`

Illustrative only — not applied by any deploy path in this repo, and
not referenced by `deployment.yaml`. Shows the shape of a real fix for
`secret.yaml`'s own "use External Secrets Operator or Sealed Secrets in
production" warning: a `SecretStore` (AWS Secrets Manager via IRSA, in
the example — swappable for Vault/GCP/Azure) and an `ExternalSecret`
that materializes the same `omniswitch-secrets` object `deployment.yaml`
already references, from a real backend instead of a checked-in,
base64'd file. Requires the External Secrets Operator controller
installed in-cluster first; this repo has no real AWS account or
equivalent to verify it against, so this file is a reference shape, not
a verified deliverable the way everything else in `k8s/` is.
