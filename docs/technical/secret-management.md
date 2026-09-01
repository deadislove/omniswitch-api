# Secret Management: Vault-Backed Envelope Encryption

`merchants.hmac_secret_ciphertext` used to be `merchants.hmac_secret` —
plaintext, in Postgres, no encryption beyond whatever the underlying disk
provided. It's the one secret this application itself generates and owns
the full lifecycle of (`JWT_SECRET`/`HMAC_SECRET`/DB credentials are
operator-supplied config; this one is minted by `MerchantService` at
merchant creation and never touched by a human). This document covers what
changed, what it actually protects against, and — as with every other
"resolved" item in this project — what it deliberately doesn't cover.

---

## The problem

`HmacSignatureGuard` needs the actual symmetric key to compute an HMAC and
compare it against `X-Signature` — unlike `apiKeySecretHash` (bcrypt,
one-way, fine for a yes/no comparison), this can't be hashed. Storing it as
plaintext meant a Postgres compromise alone — a leaked backup, an
over-permissioned read replica, a SQL injection nobody's found yet — handed
over every merchant's signing key directly, with nothing else required.

## Design

`VaultTransitService` (`src/shared/vault/vault-transit.service.ts`) wraps
Vault's [Transit secrets engine](https://developer.hashicorp.com/vault/docs/secrets/transit)
— "encryption as a service." The app never sees, stores, or manages the
actual AES key; it sends plaintext to `POST /v1/transit/encrypt/hmac-secrets`
and gets `vault:v1:<base64>` ciphertext back, and vice versa for decrypt.
Vault owns key storage, and — in a real deployment — rotation and access
policy.

```
createMerchant() / rotateHmacSecret()
  generate random plaintext hmacSecret
  → VaultTransitService.encrypt(plaintext) → ciphertext
  → store ciphertext in merchants.hmac_secret_ciphertext
  → return plaintext to the caller once (never persisted, never logged)

HmacSignatureGuard.canActivate()
  read merchant.hmacSecretCiphertext from Postgres
  → VaultTransitService.decrypt(ciphertext) → plaintext
  → use plaintext to compute/verify the HMAC (never stored)
```

**Fails closed.** If Vault is unreachable, `encrypt()`/`decrypt()` throw
rather than falling back to plaintext or skipping verification. Verified
live: stopping the `vault` container mid-session and attempting a charge
produced a 500 (an uncaught `fetch failed` surfacing through
`HmacSignatureGuard`, same as several other uncaught-exception paths already
noted elsewhere in this codebase — see the KRW-currency case in
`test/ledger-and-outbox.e2e-spec.ts`'s comments) — the request never reached
the controller, no charge was attempted. A cleaner `503` instead of a bare
`500` would be a nice polish item, but the actual security property (no
bypass) held without needing one.

**Idempotent bootstrap.** `VaultTransitService.onModuleInit()` mounts the
transit engine and creates the `hmac-secrets` key if either is missing,
checked first rather than blindly POSTed — safe for multiple replicas
starting concurrently, and safe to run on every boot. If Vault isn't ready
yet at app boot, this logs a warning and moves on rather than crashing the
app; the first real `encrypt()`/`decrypt()` call surfaces a clear error if
Vault genuinely isn't usable.

## What this does *not* cover

- **`JWT_SECRET`, DB credentials, `REDIS_PASSWORD`, and everything in
  `k8s/secret.yaml`** are still plain environment variables / base64'd K8s
  secrets. Those need External Secrets Operator or Sealed Secrets (already
  noted in `README.md`'s Security Notes) — a different problem
  (delivering config to a container) from this one (protecting a value the
  app itself generates and stores in its own database).
- **Vault itself, as deployed here, is dev-mode** — see below. None of it
  is acceptable for a real deployment as-is.

## Dev-mode Vault: what it buys you and what it costs

`docker-compose.yml`'s `vault` service runs `hashicorp/vault` in `-dev`
mode: in-memory storage, auto-unseal, a fixed root token
(`omniswitch-dev-root-token`). This is enough to prove the *pattern* works
end to end against a real Vault API — not a stub, not a mock — which is
the whole point for a reference project. It is not close to
production-ready:

- **No persistence.** Confirmed the hard way during this work: stopping and
  restarting the *same* Vault container (`docker compose stop vault` /
  `up -d vault` — not even removing it) wipes the transit engine and its
  key entirely, because dev-mode storage is in-memory. Every ciphertext
  encrypted before that restart becomes permanently undecryptable —
  verified live: re-querying Vault for a pre-restart ciphertext returned
  `"no handler for route \"transit/decrypt/hmac-secrets\""`, not a
  "wrong key" error — the whole engine mount was gone. A real deployment
  uses a persistent storage backend (Raft/integrated storage, Consul) where
  a restart doesn't lose keys.
- **A static root token, not a real auth method.** Production Vault would
  use AppRole or Kubernetes auth with short-lived tokens and a policy that
  grants this app `encrypt`/`decrypt` on exactly one key — nothing else.
  The dev-mode root token can do anything to anything in this Vault
  instance.
- **No rotation of the Transit key itself.** Vault supports versioned
  transit keys (`vault write -f transit/keys/hmac-secrets/rotate`, old
  ciphertext stays decryptable against the version it was encrypted with)
  — not exercised or automated here.

## Migration path for K8s-level secrets and production Vault

Both gaps in "What this does *not* cover" above are real, and this
section is deliberately documentation/example-only, not executable code
this project claims to have verified — there's no real cloud account,
Vault cluster, or Sealed Secrets controller in this repo's Docker Compose
setup to test either path against the way every other change here is
verified live. Writing working-but-unverified code for either would be
worse than not writing it: it would look tested when it isn't.

**`k8s/secret.yaml` → a real secret backend.** The annotation on that
file has said "use External Secrets Operator or Sealed Secrets" since
early scaffolding without ever showing what that means concretely.
[`k8s/external-secrets-example.yaml`](../../k8s/external-secrets-example.yaml)
is that: a `SecretStore` (AWS Secrets Manager via IRSA, in the example —
swap the `provider` block for Vault/GCP Secret Manager/Azure Key Vault
without touching anything else) plus an `ExternalSecret` that syncs into
the *same* `omniswitch-secrets` object name `deployment.yaml` already
references via `secretKeyRef` — so adopting this needs zero changes to
`deployment.yaml` itself, only installing the External Secrets Operator
controller in-cluster and pointing it at a real secret store. Sealed
Secrets is the other commonly-used option (encrypts a Secret client-side
with a cluster-specific public key, safe to commit the *encrypted* form
to version control) — a reasonable alternative where a team doesn't want
to depend on a live external secret-store API at deploy time, at the cost
of the encrypted blob being tied to one specific cluster's private key.

**Vault dev-mode → production Vault.** The two blocking gaps above are
independent and both need addressing: (1) swap `docker-compose.yml`'s
in-memory dev-mode storage for a persistent backend (Raft/integrated
storage is Vault's own recommended default now, Consul is the older
common choice) so a restart doesn't wipe the Transit engine and
permanently orphan every existing ciphertext; (2) replace the static
root token with AppRole or Kubernetes auth, and a policy scoped to
exactly `encrypt`/`decrypt` on the `hmac-secrets` Transit key — there's
only one Transit key today (`VaultTransitService`'s hardcoded
`TRANSIT_KEY_NAME`), reused for both HMAC secrets and TOTP secrets, not
a separate `totp-secrets` key. `VaultTransitService` itself wouldn't
need to change, since it
already just holds a token and calls the Transit API, not caring how
that token was obtained. Neither of these is a code change in this
application; both are Vault/cluster configuration this repo's
docker-compose-based dev environment was never meant to model.

## A real infra bug this surfaced: no `.dockerignore`

Unrelated to Vault specifically, but found while building the production
image to verify this change: **this repo had no `.dockerignore` file at
all.** Every `docker build`'s context — and every `COPY . .` in
`Dockerfile` — included the entire host working directory: `node_modules`
with host-specific native bindings, `.env.local` if one existed, and
critically, a stale `dist/` and `tsconfig.tsbuildinfo` left over from a
host-side build just before the container build ran. That stale
`.tsbuildinfo` made the builder stage's `nest build` treat everything as
already up to date and silently emit **zero `.js` files** — the resulting
image had `.d.ts` declaration files in `dist/` and nothing else, and
`node dist/main.js` failed with `Cannot find module`. This is exactly the
same class of "stale incremental cache" bug documented in
[`database-migrations.md`](./database-migrations.md), just leaking through
a different pipeline (Docker's build context instead of a local `tsc`
run). Fixed by adding `.dockerignore` (excludes `node_modules`, `dist`,
`*.tsbuildinfo`, `.env*`, `test/`, `docs/`, and other build-irrelevant
paths) — verified by rebuilding with `--no-cache` and confirming
`dist/main.js` and `dist/database/data-source.js` both exist and the
container boots and serves a real authenticated charge.

A second, smaller bug found in the same pass: the `vault` service's
Docker healthcheck used `wget http://localhost:8200/...`, which reported
`(unhealthy)` even though Vault was actually up — inside the container,
`localhost` resolves to `::1` first, and Vault's dev-mode listener
(`0.0.0.0:8200`) doesn't answer on IPv6. Fixed by using `127.0.0.1`
explicitly, same fix shape as the Postgres/Redis host-port collisions in
[`infra-verification-status.md`](./infra-verification-status.md) — a
different flavor of "`localhost` doesn't mean what you think it means."

## Verification

- Full e2e suite (36/36) passes with the Transit-backed flow live —
  `seedMerchant()` → `MerchantService.createMerchant()` →
  `VaultTransitService.encrypt()` → every HMAC-authenticated request in
  the suite → `HmacSignatureGuard` → `VaultTransitService.decrypt()`. This
  isn't a separate test path; it's the *only* path now, so every existing
  HMAC-signed e2e request already exercises Vault.
- Queried Postgres directly after a real e2e run: every
  `hmac_secret_ciphertext` value is genuine Vault ciphertext
  (`vault:v1:...`), never plaintext.
- Rotation verified live end to end: charged successfully with a merchant's
  original HMAC secret → called `POST
  /admin/merchants/:id/rotate-hmac-secret` through the real API → the DB
  ciphertext changed → a charge signed with the **old** secret was
  rejected (401) → a charge signed with the **new** secret succeeded.
- The production Docker image was rebuilt (`--no-cache`, after the
  `.dockerignore` fix) and run for real: `VaultTransitService`'s bootstrap
  log appeared, a fresh merchant was seeded, and a real HMAC-signed charge
  succeeded through the containerized app talking to the containerized
  Vault over the Docker network.
- Vault-down fail-closed behavior verified live (see above).

## Migration

`src/database/migrations/*-EncryptHmacSecret.ts` — a plain
`ALTER TABLE merchants RENAME COLUMN hmac_secret TO hmac_secret_ciphertext`.
No data-preserving backfill: this is a reference project without production
data, and the column's *meaning* changed (plaintext → ciphertext), not just
its name, so any pre-existing values wouldn't have been valid ciphertext
anyway. A real migration of an existing production table would need an
online re-encryption pass (read plaintext, encrypt, write ciphertext, verify,
then drop the plaintext column), not a rename.
