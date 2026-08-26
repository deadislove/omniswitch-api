# Local Infra: What's Actually Been Verified

A `tsconfig.json` cleanup (removing the deprecated `baseUrl` option) triggered
a full re-verification pass — typecheck, build, unit tests, and a real e2e
run against `docker-compose.yml`. That e2e run failed immediately, for
reasons that had nothing to do with `tsconfig.json`: several parts of the
local Docker infra had never actually worked end-to-end. This document
records exactly what got fixed, and — the point of writing this down
separately from the fix itself — exactly what was *proven* to work versus
what is still an untested assumption. Conflating those two is how the
project ended up with a docker-compose file that looked correct and wasn't.

---

## What was found broken

### 1. `mock-psp` crash-looped on every start

The service used to embed its server code as a shell heredoc inside a YAML
folded block scalar (`command: > ... cat > server.js << 'EOF' ... EOF`).
YAML's folding stripped the closing `EOF` down to a line with leading
whitespace, which breaks POSIX heredoc matching (the delimiter line must be
exact, no leading whitespace, unless using `<<-` with *tabs*). The `node
server.js` line that was supposed to run afterward got silently swallowed
into the heredoc body as literal text instead, producing a JS syntax error
and an instant exit — `docker compose ps` showed `Restarting (0)` in a tight
loop.

**Fix**: moved the script to a real file, `scripts/mock-psp/server.js`,
bind-mounted into the container (`volumes:` + `command: ["node",
"server.js"]`). No more YAML/heredoc interaction to break.

### 2. `postgres-replica` was never actually streaming

Three independent bugs stacked on top of each other:

- The bootstrap script ran `pg_basebackup` unconditionally on every
  container start, with no check for whether the data directory already had
  content. On any restart after the first, it retried against a non-empty
  target directory forever, printing a misleading "Waiting for master to be
  ready..." (the master was fine; `pg_basebackup` was failing for an
  unrelated reason each time).
- Even when it did succeed, the script wrote `standby_mode = on` into
  `recovery.conf` — which PostgreSQL **ignores completely as of version 12**
  (this stack runs Postgres 16). The correct mechanism is a `standby.signal`
  file plus `primary_conninfo` in `postgresql.auto.conf`. This means that
  even on a lucky first boot, the replica was never in real recovery/standby
  mode — it just happened to boot as an independent, non-replicating copy of
  whatever `pg_basebackup` captured at that moment.
- The master's `pg_hba.conf` had no rule permitting `replication`-type
  connections from other containers on the compose network (only loopback).
  `pg_basebackup` failed authentication before any of the above even
  mattered.

**Fix**: `docker-compose.yml`'s `postgres-replica` command now checks `[ -z
"$(ls -A ...)" ]` before attempting `pg_basebackup`, uses `standby.signal` +
`postgresql.auto.conf` instead of `recovery.conf`, fixes file ownership
(`pg_basebackup` runs as root; Postgres refuses to start as root — needs
`chown postgres:postgres` before `exec gosu postgres postgres`), and matches
the master's `max_connections=200` (a standby's `max_connections` must be
≥ the primary's, or recovery aborts with "insufficient parameter settings").
`scripts/postgres/init-master-hba.sh` was added to
`docker-entrypoint-initdb.d/` on the master to grant the `replicator` role
`host replication` access.

### 3. Host port 5432 collided with a non-Docker Postgres

Separate from anything in this repo: this machine has a Homebrew-installed
Postgres (`postgresql@14`) already bound to `127.0.0.1:5432` and
`[::1]:5432`, running independently of Docker. Connections made from the
host to `localhost:5432` landed on whichever instance won the bind race —
sometimes the Docker container, sometimes the native install, which has no
`omniswitch` role and returned `FATAL: role "omniswitch" does not exist`.
This is exactly the kind of failure that's easy to mistake for a project bug
and burn time on, when it's actually an environment collision.

**Fix**: `postgres-master`'s host-side port was remapped to `15432` in
`docker-compose.yml` (`"15432:5432"` — container-to-container traffic on the
Docker network is unaffected, since that still uses the internal port 5432).
`test/setup-env.ts` and `.env.example` were updated to match.

### 4. Host port 6379 collided with a non-Docker Redis

The same class of bug as #3, found later (while verifying the circuit
breaker sliding-window fix — DEV_README.md #9): this machine also has a
native, non-Docker `redis-server` process bound to `127.0.0.1:6379`. The
app's `REDIS_HOST=localhost`/`REDIS_PORT=6379` connections were silently
landing on it instead of the Docker container.

This one is worth being specific about because it went undetected for the
entire session up to this point, with a visible symptom that was dismissed
as harmless noise: every single e2e run printed `[WARN] This Redis
server's 'default' user does not require a password, but a password was
supplied`. Docker's `redis` service enforces a password
(`--requirepass redis_secret`); the native install doesn't. That warning
was direct evidence of the collision, present in every test run's output,
and read as ioredis being pedantic rather than as a sign anything was
wrong. **This means every earlier "verified live against Redis" claim in
this project's history was very likely exercising the native Redis, not
the Dockerized one** — not *incorrect*, exactly, since the property those
tests were actually checking (does state stay consistent across two
independent processes sharing one Redis?) still held either way, one
shared instance is one shared instance. But it was never the instance
anyone thought it was, and a future check that specifically depended on
Docker-only configuration (the password requirement itself, `maxmemory`
eviction policy, `--save`/AOF persistence settings) would have silently
tested the wrong thing.

**Fix**: same pattern as #3 — `redis`'s host-side port remapped to `16379`
in `docker-compose.yml`, `test/setup-env.ts` and `.env.example` updated to
match. Verified fixed by confirming the password warning no longer appears
in a fresh app boot's logs.

---

## Verification status

This is the actual point of this document. "Fixed" and "verified" are not
the same claim — the table below is deliberately specific about *how* each
item was checked, so a future reader doesn't have to guess whether something
was proven or assumed.

| Item | Status | How it was checked |
|---|---|---|
| `mock-psp` serves all routes correctly | ✅ Verified | Container restarted, `docker logs` confirmed a stable listener (not crash-looping), then every route (`payment_intents` create/capture/cancel, `refunds`, Adyen equivalents, `FORCE_3DS` marker) was hit directly with `curl` and via the full e2e suite. |
| `postgres-replica` performs a real `pg_basebackup` + enters standby mode from an **empty volume** | ✅ Verified | `postgres-replica-data` volume was explicitly deleted and the container recreated **repeatedly** (3–4 times, once per fix iteration) against an *already-initialized* master. Logs showed `pg_basebackup: base backup completed` → `entering standby mode` → `started streaming WAL from primary` each time. |
| Replica reflects live writes from master | ✅ Verified | A throwaway table was created and a row inserted on master; the row was visible on the replica ~1 second later via a direct query. |
| Replica survives master container restart | ✅ Verified (incidentally) | When the master was recreated for the port remap, the replica logged a transient `Connection refused`, then `started streaming WAL from primary` again on its own — self-healed without intervention. |
| `postgres-master`'s `scripts/postgres/init-master-hba.sh` actually executes via `docker-entrypoint-initdb.d` | ✅ Verified (closed gap) | Originally flagged here as unverified — the `pg_hba.conf` fix had only been applied by live-patching an *already-initialized* volume. Doing the database-migrations work below required a genuinely fresh master volume, which finally exercised this path for real: `02-init-hba.sh` ran and correctly populated `pg_hba.conf`. This also **surfaced a real bug**: `01-init.sql`'s `GRANT REPLICATION SLAVE ...` line is invalid PostgreSQL (MySQL syntax), which aborted `01-init.sql` with a syntax error on every fresh cluster init and, as a side effect, prevented `02-init-hba.sh` from ever running on a truly empty volume. Both are now fixed — see [`database-migrations.md`](./database-migrations.md#a-bug-this-surfaced-scriptspostgresinit-mastersql) for the full story. |
| A **simultaneous, full-stack** cold start (all volumes empty, one `docker compose up -d`, every `depends_on: condition: service_healthy` chain exercised at once) | ✅ Verified (closed gap) | Done as part of the database-migrations work: `docker compose down -v` removed every named volume, then `docker compose up -d postgres-master postgres-replica redis mock-psp` brought the whole stack up from nothing. Confirmed zero application tables existed before migrations ran, then a full e2e run (whose `pretest:e2e` hook applies migrations) passed 33/33 against that from-empty stack. |
| Host port remap (`15432`) resolves the `omniswitch` role correctly | ✅ Verified | `psql -h localhost -p 15432 -U omniswitch ...` and the full e2e suite both connect successfully post-remap; the native Homebrew Postgres on `5432` was confirmed to be a distinct, unaffected process throughout. |
| Host port remap (`16379`) resolves to the Docker Redis, not the native one | ✅ Verified | Fresh app boot's logs no longer show the "default user does not require a password" warning (present in every prior run). Circuit-breaker bucket keys written directly via `docker exec omniswitch-redis redis-cli` were correctly read back by a running app pointed at `REDIS_PORT=16379` — confirming both sides of the connection now agree on which Redis they mean. |
| Full e2e suite (33 tests) passes against the fixed stack | ✅ Verified | `npm run test:e2e` — 5 suites, 33/33 passing, run to completion (not just individual specs). |
| The `api` service's own Docker image: builds, runs migrations on startup, boots, and serves a real authenticated request | ✅ Verified (closed gap) | `docker compose build api` (real multi-stage build, not just `tsc`) against the fresh stack above, then `docker compose up -d api`. Container logs showed the exact intended sequence: migration SQL runs first (creating all three tables from empty), then Nest boots and maps every route. `/health/ready` reported the DB as up. A merchant was seeded directly via SQL (the only way in — merchant creation itself requires an existing ADMIN JWT, so there's no bootstrap path from zero), then a real login (`POST /auth/token`) and a real HMAC-signed charge (`POST /payments/charge`) were sent from the host to the running container. The charge reached mock-psp *over the Docker network* (`STRIPE_BASE_URL` — see below), returned `SUCCEEDED` with a real `pi_mock_...` id, and the ledger outbox relay `@Cron` job (running inside that same container) picked it up and marked it `PUBLISHED` within seconds — verified by querying Postgres directly, not by trusting the HTTP response alone. |
| `vault`'s healthcheck accurately reflects whether Vault is actually up | ✅ Verified (closed gap) | Originally reported `(unhealthy)` for a Vault that was genuinely serving requests — `wget http://localhost:8200/...` inside the container resolved `localhost` to `::1` first, and Vault's dev-mode listener doesn't answer on IPv6. Fixed by using `127.0.0.1` explicitly; confirmed healthy on the next `docker compose up -d vault`. |
| The production image actually contains compiled JavaScript, not just `.d.ts` files | ✅ Verified (closed gap) | This repo had **no `.dockerignore`** — every `docker build` copied the entire host working directory into the build context, including a stale `dist/`/`tsconfig.tsbuildinfo` from a host-side build moments earlier. That stale `.tsbuildinfo` made the builder stage's `nest build` treat the project as already compiled and emit zero `.js` files; `node dist/main.js` failed with `Cannot find module`. Fixed by adding `.dockerignore`; verified by rebuilding with `--no-cache` and directly inspecting the image (`docker run --rm --entrypoint sh ... ls /app/dist/`) for real `.js` files before trusting the container to boot. Full story in [`secret-management.md`](./secret-management.md#a-real-infra-bug-this-surfaced-no-dockerignore) (found while verifying that work, unrelated to Vault itself). |

This also caught one more real bug: the `api` service's environment block
only set `ADYEN_BASE_URL`, not `STRIPE_BASE_URL` — without it, the Stripe
adapter falls back to the real `api.stripe.com` with a placeholder key,
meaning every Stripe-routed charge from this compose stack would have
either failed or (worse, with a real key) hit production Stripe. Fixed
alongside this verification pass.

## Recommended next step

Every gap this document originally flagged is now closed. What's left is
lower-value, not "did this ever actually run":

- Load testing is now done — see
  [`load-testing.md`](./load-testing.md) for the real, reproducible
  charge-path/read-path capacity numbers against the production Docker
  image. What's still not done is a **chaos-style** test (killing a
  container mid-request, e.g. restarting `postgres-master` while a
  payment is in flight) — resilience under *mid-operation failure*,
  as opposed to sustained load, remains unverified. See Tier 2 item #11
  in `DEV_README.md`.

The seeded-merchant-via-raw-SQL step used to verify the Docker image above
was itself a real gap — there was no way to create the *first* merchant on a
brand-new deployment without already having an ADMIN JWT. **Now fixed**:
`npm run seed:admin` (`src/database/seed-admin.ts`) is an explicit, idempotent
CLI command for exactly this. Verified against a genuinely fresh, migrated
database — the credential it printed logged in and successfully onboarded a
second merchant via `POST /admin/merchants`, closing the loop without any
manual SQL. See Tier 2 item #12 in `DEV_README.md`.
