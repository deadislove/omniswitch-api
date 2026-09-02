# Local Infrastructure: Known Issues and How to Verify It Works

`docker-compose.yml` and its supporting scripts are real, runnable
infrastructure — Postgres streaming replication, Vault, Redis, a mock
PSP — not stand-ins. This document records two things separately, since
conflating them is how a docker-compose file ends up looking correct
without actually being correct: bugs that existed in this local stack
and are now fixed, and a checklist of what's actually verified to work
versus what's merely assumed, with the method to verify each yourself.

---

## Known issues (fixed)

### `mock-psp` crash-looped on every start

The service used to embed its server code as a shell heredoc inside a
YAML folded block scalar (`command: > ... cat > server.js << 'EOF' ...
EOF`). YAML's folding stripped the closing `EOF` down to a line with
leading whitespace, which breaks POSIX heredoc matching (the delimiter
line must be exact, no leading whitespace, unless using `<<-` with
*tabs*). The `node server.js` line that was supposed to run afterward
got silently swallowed into the heredoc body as literal text instead,
producing a JS syntax error and an instant exit — `docker compose ps`
showed `Restarting (0)` in a tight loop.

**Fix**: moved the script to a real file, `scripts/mock-psp/server.js`,
bind-mounted into the container (`volumes:` + `command: ["node",
"server.js"]`). No more YAML/heredoc interaction to break.

### `postgres-replica` was never actually streaming

Three independent bugs stacked on top of each other:

- The bootstrap script ran `pg_basebackup` unconditionally on every
  container start, with no check for whether the data directory already
  had content. On any restart after the first, it retried against a
  non-empty target directory forever, printing a misleading "Waiting
  for master to be ready..." (the master was fine; `pg_basebackup` was
  failing for an unrelated reason each time).
- Even when it did succeed, the script wrote `standby_mode = on` into
  `recovery.conf` — which PostgreSQL **ignores completely as of version
  12** (this stack runs Postgres 16). The correct mechanism is a
  `standby.signal` file plus `primary_conninfo` in
  `postgresql.auto.conf`. This means that even on a lucky first boot,
  the replica was never in real recovery/standby mode — it just
  happened to boot as an independent, non-replicating copy of whatever
  `pg_basebackup` captured at that moment.
- The master's `pg_hba.conf` had no rule permitting `replication`-type
  connections from other containers on the compose network (only
  loopback). `pg_basebackup` failed authentication before any of the
  above even mattered.

**Fix**: `docker-compose.yml`'s `postgres-replica` command now checks
`[ -z "$(ls -A ...)" ]` before attempting `pg_basebackup`, uses
`standby.signal` + `postgresql.auto.conf` instead of `recovery.conf`,
fixes file ownership (`pg_basebackup` runs as root; Postgres refuses to
start as root — needs `chown postgres:postgres` before `exec gosu
postgres postgres`), and matches the master's `max_connections=200` (a
standby's `max_connections` must be ≥ the primary's, or recovery aborts
with "insufficient parameter settings"). `scripts/postgres/init-master-hba.sh`
was added to `docker-entrypoint-initdb.d/` on the master to grant the
`replicator` role `host replication` access.

### Host port 5432 can collide with a non-Docker Postgres

Separate from anything in this repo: a machine with a Homebrew-installed
Postgres (`postgresql@14`) already bound to `127.0.0.1:5432` and
`[::1]:5432`, running independently of Docker, causes connections made
from the host to `localhost:5432` to land on whichever instance won the
bind race — sometimes the Docker container, sometimes the native
install, which has no `omniswitch` role and returns `FATAL: role
"omniswitch" does not exist`. This is exactly the kind of failure that's
easy to mistake for a project bug and burn time on, when it's actually
an environment collision.

**Fix**: `postgres-master`'s host-side port is remapped to `15432` in
`docker-compose.yml` (`"15432:5432"` — container-to-container traffic on
the Docker network is unaffected, since that still uses the internal
port 5432). `test/setup-env.ts` and `.env.example` match.

### Host port 6379 can collide with a non-Docker Redis

The same class of bug as the Postgres port collision above: a native,
non-Docker `redis-server` process bound to `127.0.0.1:6379` silently
intercepts the app's `REDIS_HOST=localhost`/`REDIS_PORT=6379`
connections instead of the Docker container.

This one is worth being specific about because the visible symptom is
easy to dismiss as harmless noise: every e2e run prints `[WARN] This
Redis server's 'default' user does not require a password, but a
password was supplied`. Docker's `redis` service enforces a password
(`--requirepass redis_secret`); a native install doesn't. That warning
is direct evidence of the collision — it reads as ioredis being
pedantic rather than as a sign anything is wrong, but it means requests
are landing on the wrong Redis instance entirely. A property like "does
state stay consistent across two processes sharing one Redis" would
still hold either way (one shared instance is one shared instance), but
a check that specifically depends on Docker-only configuration (the
password requirement itself, `maxmemory` eviction policy, `--save`/AOF
persistence settings) would silently test the wrong thing.

**Fix**: same pattern as the Postgres port — `redis`'s host-side port
remapped to `16379` in `docker-compose.yml`, `test/setup-env.ts` and
`.env.example` match. The password warning disappearing from a fresh
app boot's logs confirms the app is now talking to the Docker instance.

### The `api` service's environment was missing `STRIPE_BASE_URL`

The `api` service's environment block only set `ADYEN_BASE_URL`, not
`STRIPE_BASE_URL` — without it, the Stripe adapter falls back to the
real `api.stripe.com` with a placeholder key, meaning every
Stripe-routed charge from this compose stack would either fail or
(worse, with a real key) hit production Stripe. Fixed by setting
`STRIPE_BASE_URL` alongside `ADYEN_BASE_URL` to point at `mock-psp`.

---

## Verification status

"Fixed" and "verified" are not the same claim — this table is
deliberately specific about *how* to check each item, not just whether
it's believed to work.

| Item | Status | How to verify |
|---|---|---|
| `mock-psp` serves all routes correctly | ✅ Verified | Restart the container and confirm `docker logs` shows a stable listener, not a crash-loop. Every route (`payment_intents` create/capture/cancel, `refunds`, Adyen equivalents, `FORCE_3DS` marker) can be hit directly with `curl`, and is exercised by the full e2e suite. |
| `postgres-replica` performs a real `pg_basebackup` + enters standby mode from an **empty volume** | ✅ Verified | Delete the `postgres-replica-data` volume and recreate the container against an already-initialized master. Logs show `pg_basebackup: base backup completed` → `entering standby mode` → `started streaming WAL from primary`. |
| Replica reflects live writes from master | ✅ Verified | Create a throwaway table and insert a row on master — the row is visible on the replica within about a second via a direct query. |
| Replica survives master container restart | ✅ Verified | Recreating the master (e.g. for a config change) causes the replica to log a transient `Connection refused`, then `started streaming WAL from primary` again on its own — it self-heals without intervention. |
| `postgres-master`'s `scripts/postgres/init-master-hba.sh` actually executes via `docker-entrypoint-initdb.d` | ✅ Verified | Requires a genuinely fresh master volume to exercise (live-patching an already-initialized volume doesn't touch this path) — `02-init-hba.sh` runs and correctly populates `pg_hba.conf` from empty. This also surfaced a real bug: `01-init.sql`'s `GRANT REPLICATION SLAVE ...` line is invalid PostgreSQL (MySQL syntax), which aborted `01-init.sql` with a syntax error on every fresh cluster init and, as a side effect, prevented `02-init-hba.sh` from ever running on a truly empty volume. Both are fixed — see [`database-migrations.md`](./database-migrations.md#a-bug-this-surfaced-scriptspostgresinit-mastersql) for the full story. |
| A **simultaneous, full-stack** cold start (all volumes empty, one `docker compose up -d`, every `depends_on: condition: service_healthy` chain exercised at once) | ✅ Verified | `docker compose down -v` removes every named volume, then `docker compose up -d postgres-master postgres-replica redis mock-psp` brings the whole stack up from nothing. Zero application tables exist before migrations run; a full e2e run (whose `pretest:e2e` hook applies migrations) then passes against that from-empty stack. |
| Host port remap (`15432`) resolves the `omniswitch` role correctly | ✅ Verified | `psql -h localhost -p 15432 -U omniswitch ...` and the full e2e suite both connect successfully post-remap; the native Homebrew Postgres on `5432` remains a distinct, unaffected process throughout. |
| Host port remap (`16379`) resolves to the Docker Redis, not a native one | ✅ Verified | A fresh app boot's logs don't show the "default user does not require a password" warning. Circuit-breaker bucket keys written directly via `docker exec omniswitch-redis redis-cli` are correctly read back by a running app pointed at `REDIS_PORT=16379` — confirming both sides of the connection agree on which Redis they mean. |
| Full e2e suite passes against the fixed stack | ✅ Verified | `npm run test:e2e` runs to completion (not just individual specs) with every suite passing. |
| The `api` service's own Docker image: builds, runs migrations on startup, boots, and serves a real authenticated request | ✅ Verified | `docker compose build api` (real multi-stage build, not just `tsc`) against a fresh stack, then `docker compose up -d api`. Container logs show migration SQL running first (creating every table from empty), then Nest boots and maps every route; `/health/ready` reports the DB as up. `npm run seed:admin` (`src/database/seed-admin.ts`) bootstraps the first ADMIN merchant on a brand-new deployment — see [`architecture.md`](./architecture.md); a real login (`POST /auth/token`) and a real HMAC-signed charge (`POST /payments/charge`) sent to the running container reach mock-psp over the Docker network, return `SUCCEEDED` with a real `pi_mock_...` id, and the ledger outbox relay `@Cron` job (running inside that same container) picks it up and marks it `PUBLISHED` within seconds — check this by querying Postgres directly, not just by trusting the HTTP response. |
| `vault`'s healthcheck accurately reflects whether Vault is actually up | ✅ Verified | The healthcheck's own `wget http://localhost:8200/...` resolves `localhost` to `::1` first inside the container, and Vault's dev-mode listener doesn't answer on IPv6 — the healthcheck uses `127.0.0.1` explicitly to avoid this. |
| The production image actually contains compiled JavaScript, not just `.d.ts` files | ✅ Verified | Without a `.dockerignore`, every `docker build` copies the entire host working directory into the build context, including a stale `dist/`/`tsconfig.tsbuildinfo` from a host-side build — which makes the builder stage's `nest build` treat the project as already compiled and emit zero `.js` files, so `node dist/main.js` fails with `Cannot find module`. `.dockerignore` fixes this; rebuild with `--no-cache` and inspect the image directly (`docker run --rm --entrypoint sh ... ls /app/dist/`) for real `.js` files before trusting the container to boot. Full story in [`secret-management.md`](./secret-management.md#a-real-infra-bug-this-surfaced-no-dockerignore). |
| The `api` service's own Docker healthcheck accurately reflects whether the app is actually up | ✅ Verified | Same class of bug as the `vault` healthcheck above: `wget http://localhost:3000/health/live` inside the container resolves `localhost` to `::1` first, and `main.ts`'s `app.listen(port, '0.0.0.0')` only binds IPv4, so the healthcheck's own request never reaches anything — confirm via `docker exec omniswitch-api wget ... http://127.0.0.1:3000/health/live`, which succeeds immediately against the same running app. The healthcheck points at `127.0.0.1` instead of `localhost` to avoid this. See [`load-testing.md`](./load-testing.md) for the full trace. |

---

## What's not covered

Load testing is covered — see [`load-testing.md`](./load-testing.md)
for real, reproducible charge-path/read-path capacity numbers against
the production Docker image. What's still not exercised is a
**chaos-style** test (killing a container mid-request, e.g. restarting
`postgres-master` while a payment is in flight): resilience under
*mid-operation failure*, as opposed to sustained load, remains
unverified. See Tier 2 item #11 in `DEV_README.md`.
