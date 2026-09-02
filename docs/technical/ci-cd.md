# CI/CD

Two GitHub Actions workflows, plus Dependabot, run against every push and
pull request to `main`. This document covers what each one does, why
certain gates are blocking and others aren't, and two failure modes this
pipeline is built to guard against — both with root causes that aren't
obvious from the failure output alone, worth reading before touching
either workflow file.

## `.github/workflows/ci.yml`

Two jobs, run in parallel.

**`build-and-unit-test`**: `npm ci` → lint (report-only, see below) →
`tsc --noEmit` → `npm run build` → `npm test` (unit tests, mocked
dependencies).

**`e2e`**: brings up `postgres-master`, `postgres-replica`, `redis`,
`vault`, `mock-psp` via `docker compose up -d --wait` (same services,
same host-mapped ports `test/setup-env.ts` already assumes — see
[`architecture.md`'s Testing section](./architecture.md#testing)), then
runs `npm run test:e2e`. `api` itself is deliberately not started — the
e2e suite talks to a Nest app booted in-process by Jest/Supertest
(`test/utils/test-app.ts`), not to the containerized `api` service.

Note: this job does **not** bring up `pgbouncer-master`/`pgbouncer-replica`
— `test/setup-env.ts`'s defaults point straight at Postgres, same as
migrations do, so the e2e suite doesn't exercise the pooler by default.
Pointing `DB_MASTER_HOST`/`DB_REPLICA_HOST` at the pooler's host ports
instead exercises that path separately — see
[`load-testing.md`](./load-testing.md), Finding #3 — but CI itself
doesn't cover it.

**Lint is report-only, not blocking.** The raw (no `--fix`) codebase
currently produces ~8.7k findings — mostly `eslint-plugin-prettier`
formatting diffs (no `.prettierrc` exists, so prettier's default
double-quote style fights this codebase's actual single-quote
convention), plus a parsing error on every file under `test/` (
`tsconfig.json` excludes `test/`, so `parserOptions.project` can't
type-check those files at all). Both are real, pre-existing gaps —
fixing them means a deliberate repo-wide reformat plus a
tsconfig/`.eslintrc` adjustment, not something to do silently as a side
effect of wiring up CI. Until that happens, this step reports findings
without failing the build on them.

## `.github/workflows/security-scan.yml`

Five independent jobs: **Trivy** (dependency CVEs, Dockerfile/
docker-compose/k8s misconfig, secret scanning), **Bearer** (application-
level SAST — sensitive data flows, OWASP-style rules), **Gitleaks**
(secret scanning across full git history, not just the current tree),
**ESLint security rules** (`eslint-plugin-security`, Node.js-specific
unsafe patterns — `eval`, non-literal `fs`/`child_process` calls, timing
attacks, etc.), and **npm audit**.

Each tool runs twice: a full report (`CRITICAL,HIGH`/`moderate`+,
`continue-on-error`/`|| true`) for visibility, and a blocking gate scoped
to `CRITICAL`-only severity. The blocking gate is deliberately narrow —
today's baseline has a handful of pre-existing HIGH findings (transitive
npm CVEs in `js-yaml`/`lodash`/`multer`, one k8s `readOnlyRootFilesystem`
hardening recommendation) that aren't part of this pipeline's own scope
to fix, but zero CRITICAL findings — so the gate actually catches new
regressions instead of failing on day one and training everyone to
ignore it.

**Suppressions are scoped by exact value, not by rule or path.**
`trivy-secret.yaml` and `.gitleaks.toml` both allowlist the *specific
regex* of this codebase's known test placeholder values (e.g.
`sk_test_placeholder`), not the underlying detection rule — feeding
either scanner a differently-shaped fake key still gets it flagged, which
is what the narrow, value-scoped allowlist is for. `.eslintrc.security.cjs`
disables `security/detect-object-injection` entirely, but only after
checking every one of its hits in this codebase and confirming all were
false positives (e.g. `VALID_TRANSITIONS[from]` where `from` is a closed
TypeScript enum, not attacker-controlled input) — the plugin's own docs
acknowledge that rule "100% will have false positives."

## `.github/dependabot.yml`

Three ecosystems, weekly: `npm` (patch/minor bumps grouped into one PR;
majors get their own), `docker` (base images in `Dockerfile` and
`docker-compose.yml`), `github-actions` (pinned action versions in
`.github/workflows/*.yml`).

## Known flaky-test classes

Two categories of failure are pre-existing, intermittent, and
unconnected to whatever change happens to be in the PR when they show
up:

- **Rate-limit bursts** (`429 Too Many Requests`): the full e2e suite's
  cumulative request volume shares one rate-limit window (see
  [`architecture.md`'s Testing section](./architecture.md#testing)).
  Reconfirms clean on an immediate re-run essentially every time.
- **Heap-threshold health check** (`api-versioning.e2e-spec.ts`, `503`
  on `/health`): see
  ["The e2e heap-threshold health check failure"](#the-e2e-heap-threshold-health-check-failure)
  below for why this class of failure exists and what bounds it now.

If a CI run fails and the failure is exactly one of these two shapes,
in a file the current PR didn't touch, re-running the job first is
reasonable before assuming a regression.

---

## Replica-lag races in read-after-write code paths

`app.module.ts`'s TypeORM `replication` config routes plain repository
reads to the Postgres replica, which streams from master with genuine,
non-zero lag (~1s, measured and documented in
[`architecture.md`](./architecture.md)). Any code that reads a row
shortly after writing it (its own write, or something else's) races that
lag — fine when the replica happens to catch up inside the gap between
the write and the follow-up read, flaky exactly when it doesn't.

**Where this recurs**: e2e spec files that read their own write back
immediately (`dataSource.getRepository(...).findOne()` right after a
`POST`/`PATCH` that just committed to master) hit this reliably enough
to be a known pattern, not a one-off — a full-repo sweep for the
`dataSource.getRepository(...).find/findOne/count` pattern against
recently-written rows found it latent across 11 files:
`agentic-payments`, `cross-border-settlement`, `fx-conversion`,
`ledger-and-outbox`, `marketplace-split-refunds`, `marketplace-splits`,
`plans`, `reserve`, `risk-tiering`, `subscriptions`, `webhooks` (each
now forces the read onto master — see e.g. `findOneOnMaster()` in those
spec files). Two production code paths had the identical bug for the
identical reason:

- `LedgerOutboxTypeOrmRepository.findPending()` — the query the outbox
  relay's `@Cron` job uses to find work; a background poller has
  nothing to gain from replica routing and everything to lose from the
  extra lag.
- `MerchantService.verifyCredentials()` — the method behind
  `POST /auth/token`, i.e. **every login**, in both tests and real
  production deployments. A merchant created via `createMerchant()`
  (commits to master) and immediately logging in races the replica: the
  plain (replica-routed) `findOne()` this method used can return `null`
  before the replica catches up — indistinguishable, by design (see that
  method's own docblock on why it doesn't leak the difference), from a
  genuinely wrong password. This is not just a test artifact: an admin
  onboarding a merchant who tries to log in right away is an ordinary
  real-world sequence that hits the same window. The same fix was
  applied to the shared `getOrThrow()` private helper, used by 10+ admin
  mutation endpoints (`updateFeeRate`, `updateSettlementCurrency`,
  `setActive`, ...) that could plausibly run immediately after
  `createMerchant()` in a real flow, not just a test.

**Fix, applied consistently everywhere this shows up**: read through
`dataSource.createQueryRunner('master')` instead of the ambient
(replica-routed) repository, for any read that needs to see a write that
may have only just committed.

**The audit lesson**: master/replica routing is an ambient property of
the whole app's `DataSource` — it doesn't stop at the test boundary. The
places most worth auditing for this are exactly the ones a test harness
exercises tightly and back-to-back (`create` immediately followed by
`read`), even though a real caller might naturally insert more of a gap
— which is exactly why test files surface this bug class before
production traffic patterns do.

## The e2e heap-threshold health check failure

**The problem**: `test/jest-e2e.json` runs with `maxWorkers: 1`, so all
19 e2e spec files execute sequentially inside **one OS process**. Each
file's `createTestApp()` calls
`Test.createTestingModule({ imports: [AppModule] }).compile()` — a full
NestJS DI container + TypeORM entity metadata + class-validator metadata
build — and that heap usage doesn't fully release between files. By the
tail end of a ~170-second, 170-test run, cumulative heap usage can cross
the health check's 512MB threshold (`src/health/health.controller.ts`),
failing whichever file happens to run last with a `503` on `/health` —
usually `api-versioning.e2e-spec.ts`.

Three approaches to reducing the test harness's own memory footprint
were tried and didn't hold up; the actual fix addressed a different
premise entirely.

**Jest's `workerIdleMemoryLimit` doesn't transfer to CI hardware.** This
setting kills and restarts a worker once its memory usage after
finishing a file exceeds a configured limit, giving every subsequent
file a fresh heap — a plausible direct fix. Tuned and confirmed clean
against three consecutive full local e2e runs, it still failed
dramatically on GitHub Actions: 61 of 170 tests across 17 of 19 suites,
including `auth.e2e-spec.ts`'s most basic "log in and get a JWT" test,
which nothing about the change touched. GitHub Actions runners have far
less memory/CPU headroom than a typical development machine — a single
`ts-jest`/`ts-node`-compiled NestJS app boot likely already sits near or
above the configured 400MB threshold on that runner, so instead of
triggering "occasionally, near the end of the suite" the way it did
locally, it very likely triggered after nearly every file, turning what
should have been one continuous, stable run into constant
worker-process churn. That churn — not any single logic bug — is the
most plausible explanation for failures this broad and this evenly
spread across unrelated files. **The lesson**: any setting whose
behavior depends on the *resource envelope of the machine it runs on*
(memory limits, worker counts, timeouts tuned against wall-clock time)
cannot be validated by local testing alone, no matter how clean the
local results look — it needs to be checked directly against the actual
CI runner, or replaced with an approach that doesn't depend on guessing
at the runner's available headroom.

**Forcing garbage collection doesn't help, because the growth isn't
reclaimable garbage.** The alternative theory: heap simply wasn't being
reclaimed promptly enough between files, fixable by running Jest with
`--expose-gc` and calling `global.gc()` in an `afterAll` hook after each
spec file's own `app.close()`. Measured with `jest --logHeapUsage`, heap
climbs at essentially the same rate with the GC hook active as without
it (471MB → 670MB across the 19 files, ~10MB/file, same trajectory that
trips the threshold either way) — the explicit `global.gc()` calls do
run (confirmed via `typeof global.gc === 'function'`), they just don't
help, because the growth is live, still-referenced state, not garbage:
most likely `reflect-metadata`'s global metadata registry and ts-jest's
compiled-module cache, both of which grow with every fresh
`Test.createTestingModule({ imports: [AppModule] }).compile()` call and
have no reason to ever be garbage-collected within the same process.
This rules out any same-process fix.

**Sharding into separate OS processes only partially works, because the
per-process *baseline* is already most of the threshold.** `jest --shard`
runs the suite as several genuinely fresh Node processes instead of one,
bounding how many files' worth of NestJS/reflect-metadata state can
accumulate in any one process. Splitting into 4 shards of ~5 files each
still failed: shard 2/4 hit both `api-versioning.e2e-spec.ts`'s heap
check *and*, more tellingly, a `401` on a basic login call in
`subscriptions.e2e-spec.ts` that nothing about sharding should affect.
That second failure is the real signal — this isn't "19 files is too
many for one process," it's that a single fresh process running as few
as 5 files was already landing close enough to 512MB that normal
run-to-run variance could tip it over, consistent with the
`--logHeapUsage` diagnostic above showing heap already at 471MB after
just the *first* file, before any per-file accumulation even enters the
picture. Sharding reduces how much accumulates *across* files — it does
nothing about the *baseline* cost of one ts-jest-compiled NestJS app
boot, which is already most of the way to the threshold on its own.

**What actually fixed it: the threshold was never a fair test to begin
with.** The 512MB/1GB thresholds in `health.controller.ts` are correctly
calibrated against `k8s/deployment.yaml`'s real 512Mi pod memory
limit — meaningful for a compiled `node dist/main.js` production
process. But the e2e test harness runs that same health check inside a
process that also carries `ts-jest`'s TypeScript compiler and Jest's own
machinery resident in memory the entire time — overhead a real
deployment never has. No amount of reducing *test* memory use (GC,
sharding) changes that the harness itself was already consuming most of
a budget sized for production. `health.controller.ts`'s thresholds are
read from `ConfigService`
(`HEALTH_CHECK_HEAP_THRESHOLD_BYTES`/`HEALTH_CHECK_RSS_THRESHOLD_BYTES`),
defaulting to the same 512MB/1GB — production's behavior and
`k8s/deployment.yaml` are untouched, since no env var sets these outside
the test environment. `test/setup-env.ts` raises them to 1.5GB/2GB for
e2e runs only; the `jest --shard` change in `ci.yml` was reverted, since
it added CI runtime without fully solving the problem on its own.
`ConfigService.get<number>()` does not actually cast — an env var
override comes back as a string despite the generic type argument — so
both threshold reads in `health.controller.ts` are wrapped in
`Number(...)` explicitly rather than relying on `checkHeap()`'s internal
`>` comparison to coerce it correctly. Peak heap across full local e2e
runs sits around 600–800MB — comfortably clear of the old 512MB
threshold (which would fail) and well inside the new 1.5GB one.

**The general lesson**: all three of the attempts above tried to make
the *test harness* use less memory. The actual fix was recognizing that
the specific numeric threshold being asserted was calibrated for an
environment (compiled production code) the test was never running in.
When a test's pass/fail boundary is a hardcoded number, it's worth
asking whether that number's calibration context still applies to the
environment actually running the test — not just whether the code under
test can be made to fit under it.
