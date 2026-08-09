# CI/CD

Two GitHub Actions workflows, plus Dependabot, run against every push and
pull request to `main`. This document covers what each one does, why
certain gates are blocking and others aren't, and — the main reason it's
worth reading before touching either workflow file — two real incidents
this pipeline has already been through, both with root causes that
weren't obvious from the failure output alone.

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
`sk_test_placeholder`), not the underlying detection rule — verified
live by feeding each scanner a differently-shaped fake key and
confirming it still gets flagged. `.eslintrc.security.cjs` disables
`security/detect-object-injection` entirely, but only after checking
every one of its hits in this codebase and confirming all were false
positives (e.g. `VALID_TRANSITIONS[from]` where `from` is a closed
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
up. Both are already documented in detail in `DEV_README.md`'s
development history; summarized here because they're specifically
CI-relevant:

- **Rate-limit bursts** (`429 Too Many Requests`): the full e2e suite's
  cumulative request volume shares one rate-limit window (see
  [`architecture.md`'s Testing section](./architecture.md#testing)).
  Reconfirms clean on an immediate re-run essentially every time.
- **Heap-threshold health check** (`api-versioning.e2e-spec.ts`, `503`
  on `/health`): see the workerIdleMemoryLimit incident below for why
  this happens and why it's still unresolved.

If a CI run fails and the failure is exactly one of these two shapes,
in a file the current PR didn't touch, re-running the job first is
reasonable before assuming a regression.

---

## Incident: replica-lag races surfaced by a routine Dependabot PR

**Date**: 2026-08-09. **Commit**: `478f5a6 fix: force master read to
avoid replica-lag races and #1.`

A Dependabot PR bumping `actions/setup-node` from v4 to v7 (a
CI-tooling-only change) failed its `e2e` check. Every other job in that
PR passed — the failure had nothing to do with the action version bump
itself.

**Root cause**: `app.module.ts`'s TypeORM `replication` config routes
plain repository reads to the Postgres replica, which streams from
master with genuine, non-zero lag (~1s, already measured and documented
in [`architecture.md`](./architecture.md) and surfaced once before in
`reserve.service.ts`'s `release()`). Several e2e spec files read their
own write back immediately (`dataSource.getRepository(...).findOne()`
right after a `POST`/`PATCH` that write just committed to master) — a
pattern that's fine when the replica happens to catch up inside the gap
between the HTTP response and the follow-up query, and flaky exactly
when it doesn't.

The specific failure was `fx-conversion.e2e-spec.ts`: a `PATCH` that
clears a merchant's `settlementCurrency`, followed immediately by a
re-read that occasionally still saw the pre-clear value.

**Fix**: every affected read was rewritten to go through
`dataSource.createQueryRunner('master')` instead of the ambient
(replica-routed) repository. This turned out to be latent in 9 files
total, not just the one that happened to fail this particular run — a
full-repo sweep for the same `dataSource.getRepository(...).find/
findOne/count` pattern found and fixed all of them:
`agentic-payments`, `cross-border-settlement`, `fx-conversion`,
`ledger-and-outbox`, `marketplace-split-refunds`, `marketplace-splits`,
`plans`, `reserve`, `risk-tiering`, `subscriptions`, `webhooks`. One
production code path had the identical bug for the identical reason:
`LedgerOutboxTypeOrmRepository.findPending()` (the query the outbox
relay's `@Cron` job uses to find work) was also reading from the
replica — fixed the same way, since a background poller has nothing to
gain from replica routing and everything to lose from the extra lag.

**Verified**: `tsc --noEmit` clean; full e2e suite run to completion
multiple times post-fix, 170/170 passing (aside from the pre-existing
flakes above, each reconfirmed clean on immediate re-run).

## Incident: a heap-flake fix that worked locally and broke CI

**Date**: 2026-08-09. **Commits**: `ab092bc fix: memory incident in the
test stage.` (the change), followed by a revert once the actual CI
result came back.

**The problem being fixed**: `test/jest-e2e.json` runs with
`maxWorkers: 1`, so all 19 e2e spec files execute sequentially inside
**one OS process**. Each file's `createTestApp()` calls
`Test.createTestingModule({ imports: [AppModule] }).compile()` — a full
NestJS DI container + TypeORM entity metadata + class-validator
metadata build — and that heap usage doesn't fully release between
files. By the tail end of a ~170-second, 170-test run, cumulative heap
usage would occasionally cross the health check's 512MB threshold
(`src/health/health.controller.ts`), failing whichever file happened to
run last with a `503` on `/health` — usually
`api-versioning.e2e-spec.ts`.

**The attempted fix**: Jest has a built-in mechanism for exactly this —
`workerIdleMemoryLimit`. Once a worker's memory usage after finishing a
file exceeds the configured limit, Jest kills and restarts that worker
before handing it the next file, giving every subsequent file a
genuinely fresh heap. `"workerIdleMemoryLimit": "400MB"` was added to
`test/jest-e2e.json`.

**Verified locally — three consecutive full e2e runs (170/170,
`api-versioning.e2e-spec.ts` passing every time), against the same
Docker Compose stack CI uses.** This is the part worth being explicit
about: local verification here wasn't skipped or rushed, and it looked
conclusive.

**What actually happened on GitHub Actions**: the very next CI run,
against the exact same commit, failed **61 of 170 tests across 17 of 19
suites** — including `auth.e2e-spec.ts`'s most basic "log in and get a
JWT" test, which nothing in the change touched. The failure shapes were
wide and inconsistent (`401` on logins that should succeed, `404`s,
wrong business-logic values, `undefined` where a record should exist) —
the signature of environment instability, not a logic regression in any
one file.

**Root cause**: GitHub Actions runners have far less memory/CPU headroom
than the machine this was verified on locally. A single `ts-jest`/
`ts-node`-compiled NestJS app boot likely already sits near or above
400MB on that runner — meaning `workerIdleMemoryLimit: 400MB` didn't
trigger "occasionally, near the end of the suite" the way it did
locally. It very likely triggered **after nearly every file**, turning
what should have been one continuous, stable run into constant
worker-process churn. That churn — not any single logic bug — is the
most plausible explanation for failures this broad and this evenly
spread across unrelated files.

**Resolution**: reverted. `workerIdleMemoryLimit` was removed from
`test/jest-e2e.json`, restoring the exact config from `478f5a6` (the
last commit confirmed clean in CI). This brings back the original,
narrower heap-threshold flake described above — a known, occasional,
single-file failure — which is a strictly smaller problem than a
run that fails ~36% of all tests.

**The actual lesson**: this class of setting — anything whose behavior
depends on the *resource envelope of the machine it runs on* (memory
limits, worker counts, timeouts tuned against wall-clock time) — cannot
be validated by local testing alone, no matter how many times it's run
locally or how clean the results look. GitHub Actions' `ubuntu-latest`
runners are meaningfully more constrained than a developer laptop. A
future attempt at fixing the heap flake this way should either be
tuned and verified directly against a real CI run (not just Docker
Compose on a local machine), or take a different approach that doesn't
depend on guessing at the runner's available headroom — e.g. splitting
the e2e run into a few smaller `jest --shard` invocations (bounding how
much any one process accumulates) instead of recycling workers by a
memory threshold.

### A second attempt that also didn't work: forcing GC

Before landing on sharding, a second idea was tried and measured, not
just assumed: run Jest with `--expose-gc` and call `global.gc()` in an
`afterAll` hook (`setupFilesAfterEnv`) after each spec file's own
`app.close()`, on the theory that heap simply wasn't being reclaimed
promptly enough between files.

This one was actually falsified *locally*, before ever reaching CI —
`jest --logHeapUsage` showed heap climbing at essentially the same rate
with the GC hook active as without it (471MB → 670MB across the 19
files, ~10MB/file, same trajectory that previously tripped the
threshold). The explicit `global.gc()` calls were confirmed to actually
run (`--expose-gc` verified present via `typeof global.gc ===
'function'`) — they just didn't help, because the growth isn't
reclaimable garbage. It's live, still-referenced state — most likely
`reflect-metadata`'s global metadata registry and ts-jest's compiled-
module cache, both of which grow with every fresh
`Test.createTestingModule({ imports: [AppModule] }).compile()` call and
have no reason to ever be garbage-collected within the same process.
This ruled out any same-process fix and is why sharding (separate OS
processes, not memory management within one process) is the current
approach.

### Current approach: `jest --shard`

`ci.yml`'s e2e job now runs `npm run pretest:e2e` once (migrations),
then four separate `npx jest --config ./test/jest-e2e.json
--shard=$i/4` invocations in sequence — each a genuinely fresh Node
process, so at most ~5 files' worth of NestJS/reflect-metadata state
accumulates in any one process instead of all 19. The four shards still
run sequentially against the same Docker Compose stack, preserving the
existing no-concurrent-state guarantee (`maxWorkers: 1` already made
every file within a shard sequential; this doesn't change that, it just
adds process boundaries between groups of files).

Verified locally: all 4 shards pass (19/19 suites, 170/170 tests). Per
this document's own lesson two sections up, that is **not** sufficient
evidence this fixes the CI failure — it only confirms the sharding
mechanism itself works. Whether it actually prevents the heap threshold
from being crossed depends on the CI runner's memory profile, which can
only be confirmed by an actual CI run. If a shard still fails the
health check, the next lever is a higher shard count (smaller groups
per process) rather than another same-process trick.
