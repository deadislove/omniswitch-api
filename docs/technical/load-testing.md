# Load Testing

Nothing in this repo previously established what "normal" throughput/latency
looks like, so there was no way to tell whether a future change regressed
performance, and no evidence for `k8s/hpa.yaml`'s 70% CPU / 80% memory
scale-out thresholds — reasonable-looking defaults, never actually
measured. This is a real, reproducible baseline against the real stack
(Docker Compose Postgres/Redis/mock-psp, the actual production Docker
image, [Artillery](https://www.artillery.io/) as the load generator — not
a synthetic in-process benchmark), plus what it took to get a *meaningful*
number out of this specific system.

## Setup

- The `api` service's actual `docker-compose.yml` container, built from the
  real production Dockerfile target — not `npm run start:dev`.
- Resource-constrained to match `k8s/deployment.yaml`'s **limits**
  (`docker update --cpus=1 --memory=512m`) so `docker stats` readings are
  directly comparable to what one pod is actually capped at in the cluster
  manifest, not whatever the host machine happens to have free.
- Artillery scripts, merchant/payment fixture seeders, and processors live
  in `scripts/load-test/`. To reproduce:
  ```bash
  docker compose up -d --build api   # + postgres/redis/mock-psp/vault
  npm run seed:admin                 # prints apiKeyId/apiKeySecret — needed below

  # Seed N test merchants (writes scripts/load-test/.merchants.json, gitignored)
  TARGET_URL=http://localhost:3000 \
  LOAD_TEST_ADMIN_API_KEY_ID=<from seed:admin> \
  LOAD_TEST_ADMIN_API_KEY_SECRET=<from seed:admin> \
  LOAD_TEST_MERCHANT_COUNT=200 \
  node scripts/load-test/setup-merchants.js

  npm run load-test:charge           # single/spread-merchant charge runs (Finding #1)

  # One real payment per merchant, for the read-capacity run:
  LOAD_TEST_PAYMENTS_PER_MERCHANT=1 node scripts/load-test/seed-payments.js

  # RATE_LIMIT_MAX/RATE_LIMIT_BURST_MAX must be raised before this step —
  # see the note below. Restart `api` with both set high, THEN:
  npm run load-test:read             # read-path capacity run (Finding #2)
  ```
  Fixture files (`.merchants.json`, `.payments.json`) are gitignored,
  regenerated per run — a merchant/payment id from one run won't exist in
  the next.

  **`RATE_LIMIT_MAX`/`RATE_LIMIT_BURST_MAX` must be raised for the
  read-capacity run too, not just for merchant/payment seeding** — this
  was missing from these steps until 2026-08-22 and produces a
  misleading result if skipped. `GET /payments/:id` carries no
  route-level `@Throttle` override, but it's still covered by the
  *global*, IP-scoped `ThrottlerGuard` (`default`: 100 req/60s,
  `burst`: 10 req/1s — see `app.module.ts`'s `ThrottlerModule.forRootAsync`).
  Every request in this test originates from the same load-generator IP
  regardless of how many merchants it's spread across, so at this
  test's 150 req/s sustained rate, the global cap (not the per-merchant
  one `RATE_LIMIT_MAX` most directly evokes) becomes the binding
  constraint within the first second — the resulting near-total `429`
  rate looks like a capacity problem but is actually just the global
  limiter doing its job. Finding #2 exists to measure the app's own
  read-path ceiling, not re-measure the global rate limiter (already
  covered by Finding #1's reasoning) — so, same as the merchant-seeding
  step already did, restart `api` with `RATE_LIMIT_MAX`/
  `RATE_LIMIT_BURST_MAX` set high (e.g. `100000`) before running
  `load-test:read`, and restore the real defaults afterward.

## Finding #1: a single load-generator IP can't reach this app's own ceiling — the rate limiter gets there first

The first three runs, in order, are the story of chasing this down —
kept here because each one is a real, separate rate-limiting layer, and
understanding all three matters for anyone tuning these limits later.

**Run 1 — one merchant, default limits.** 6676 requests, 5604 came back
`429`. Expected once you know why: `POST /payments/charge` and
`GET /payments/:id` both carry `MerchantThrottlerGuard`
(`merchant:{merchantId}`-scoped, layered on top of the global IP-scoped
guard), and with every request authenticating as the same merchant, that
single merchant's 100 req/min budget is the very first thing hit.

**Run 2 — 20 merchants, default limits.** Spreading load across 20
distinct merchants (a more realistic multi-tenant shape anyway) barely
moved the needle: 6700 requests, still 5554 `429`s. The reason: the
*global* `ThrottlerGuard` (`APP_GUARD` in `AppModule`) is IP-scoped, not
merchant-scoped, and every request in this test — regardless of which
merchant JWT it carries — originates from the same machine. Spreading
traffic across merchant identities does nothing against a guard keyed on
source IP.

**Run 3 — 200 merchants, `RATE_LIMIT_MAX`/`RATE_LIMIT_BURST_MAX` raised
1000x.** Still 6700 requests, still only 400 charges succeeded — the exact
same number as Run 2. This is the real finding: `PaymentController.charge()`
carries its own **hardcoded, route-level** override,
`@Throttle({ default: { limit: 100, ttl: 60000 } })`, independent of the
`RATE_LIMIT_MAX` env var entirely. Because the *global* IP-scoped guard
and the *merchant-scoped* guard both check the same `'default'` throttler
name, both pick up this override — and since this whole test runs from one
source IP, the IP-scoped copy of that 100/min cap becomes the binding
constraint regardless of how many merchants share it. Raising
`RATE_LIMIT_MAX` doesn't touch it, because it was never the `RATE_LIMIT_MAX`
tier being enforced.

None of this is a bug — `AUTH_LOGIN_RATE_LIMIT` (anti-brute-force on
`POST /auth/token`) and the charge endpoint's dedicated cap are both
deliberate, and correctly reject a single IP firing many charges
regardless of how many merchant identities it cycles through, which is
exactly the profile of a credential-stuffing/card-testing attack. It does
mean: **a single-machine load generator cannot measure this app's own
processing ceiling for the charge endpoint** — it will always hit this
cap first, by design. A real capacity test against the charge path
specifically would need traffic from many distinct source IPs (a
distributed load generator), which is out of scope for this reference
project. `docker-compose.yml` exposes `AUTH_LOGIN_RATE_LIMIT`,
`RATE_LIMIT_MAX`, and `RATE_LIMIT_BURST_MAX` as overridable env vars
(defaults unchanged) specifically so *seeding* fixtures for a load test
doesn't itself get rate-limited — that's a different thing from measuring
the charge path's own ceiling, which the route-level override always wins
against from one IP.

**Re-run 2026-08-10 against the NestJS v10→v11 upgrade** (which bundles
Express 5, a materially different HTTP layer than everything measured
above): same shape, same numbers — 6700 requests, 400 succeeded (`201`),
5274 hit the route-level `429` cap, **zero `5xx`s**. The route-level cap
is unaffected by the framework/HTTP-server upgrade, as expected.

**Re-run 2026-08-22**, on a fully rebuilt environment (fresh volumes,
fresh image build) after this round's `src/jobs/` background-job
additions and documentation expansion (none of which touch the charge
path) — 200 seeded merchants, default rate limits: 6700 requests, 400
succeeded (`201`), 5548 hit the route-level `429` cap, **zero `5xx`s**.
Matches the historical 400-succeeded figure exactly — same shape, same
conclusion, no regression.

**Re-run 2026-08-24**, on a fully rebuilt environment (fresh volumes,
fresh image build) after this round's per-merchant PSP entitlement
work (`MerchantEntity.enabledPspProviders`, the `preferredProvider`
true-override fix, and an e2e-only circuit-breaker-state-leak fix —
see `docs/spec/future/per-merchant-psp-entitlement.md` and
`distributed-resilience-and-cde-isolation.md`) — none of which touch
the charge path's rate-limiting. 200 seeded merchants, default rate
limits: 6700 requests, **400 succeeded (`201`)**, 5278 hit the
route-level `429` cap, **zero `5xx`s**. Matches the historical
400-succeeded figure exactly — same shape, same conclusion, no
regression. (This environment's Docker Compose stack — containers and
volumes — had been removed entirely since the last pass, for reasons
outside this session's own actions; rebuilt fresh via `docker compose
up -d --build` before this run, same as every "fully rebuilt
environment" pass above.)

## Finding #2: read-path capacity, unconstrained by the charge-specific cap

`GET /payments/:id` has no route-level `@Throttle` override — only the
general (now-raised, for this run) tiers apply. This is what actually
answers the original question: what can one pod, resource-capped like the
k8s manifest, sustain?

**Setup**: 200 merchants, one real payment seeded per merchant (200 total,
paced under the charge cap above — not part of what's measured), then a
sustained read load: 20s warm-up at 10 req/s, 40s ramp to 150 req/s, 90s
sustained at 150 req/s.

**Result**: **16,900 / 16,900 requests succeeded — zero failures**, at up
to 150 req/s sustained.

**Current numbers (2026-08-10, re-measured against the NestJS v10→v11 +
Express 4→5 upgrade)** — three consecutive runs against the same
resource-capped container, since a single run turned out not to be a
reliable read of the tail:

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Requests succeeded | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 |
| p50 latency | 3ms | 3ms | 3ms |
| p95 latency | 8.9ms | 8.9ms | 7ms |
| p99 latency | 54.1ms | 23.8ms | 15ms |
| max latency | 377ms | 112ms | 62ms |
| Error rate | 0% | 0% | 0% |

Run 1 (right after the container was (re)built and DB/JIT were still
cold) has a visibly heavier tail than Runs 2-3 — p50/p95 are identical
across all three, so this reads as a warm-up/host-scheduling artifact,
not a per-request cost that changed. Runs 2-3 match or beat the original
pre-upgrade baseline (p50 3ms / p95 7.9ms / p99 25.8ms / max 218ms) on
every metric. 50,700 requests total across the three runs, zero
failures. **Conclusion: no throughput or latency regression from the
NestJS v11 / Express 5 upgrade.**

**Re-run 2026-08-21**, after the accumulated dependency bumps since
2026-08-10 (TypeORM 0.3→1.1, jest 29→30, pg 8.22→8.23, stripe 14→22,
`@typescript-eslint` 8.66→8.67, `class-validator` 0.14→0.15) plus
replacing the `uuid` npm package with Node's native `crypto.randomUUID()`
(v4) and a local SHA-1-based `uuidv5()` (see `src/shared/utils/uuid.ts`)
— `uuid@14` ships ESM-only, which broke this project's CommonJS Jest
setup, so it was dropped as a dependency entirely rather than worked
around. Three consecutive runs, same methodology:

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Requests succeeded | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 |
| p50 latency | 3ms | 2ms | 3ms |
| p95 latency | 7.9ms | 7ms | 6ms |
| p99 latency | 13.9ms | 12.1ms | 10.9ms |
| max latency | 89ms | 83ms | 65ms |
| Error rate | 0% | 0% | 0% |

Success rate and latency match the 2026-08-10 baseline (if anything,
p99/max are tighter — no run reproduced that baseline's 54.1ms/377ms
tail). 50,700 requests total, zero failures. **Conclusion: no throughput
or latency regression** — and, per the CPU/memory numbers below, a
real drop in per-request resource cost.

**Re-run 2026-08-22**, after this round's data-retention additions
(partition maintenance, cutover-table cleanup, pluggable cloud
`BackupStorage`, legal hold) and this round's documentation expansion
(`docs/guide/jobs/`, `docs/technical/jobs.md`, `docs/technical/databases/`,
`docs/technical/clouds/`), none of which touch the charge/read request
path. An earlier same-day pass showed noisy, run-over-run-increasing
CPU/latency; that pass turned out to have run on a host with a large
accumulation of unrelated Docker resources (over 40GB of images and
build cache, dozens of dangling volumes from unrelated work on the same
machine) competing for disk/CPU in the background. The numbers below
are from a full clean rebuild (fresh volumes, fresh image build) after
that accumulation was cleared, and supersede the earlier same-day pass.
Three consecutive runs, same methodology as every prior date above —
200 seeded merchants (the established count for this methodology —
150 req/s split across fewer merchants pushes each one's own share past
its 100/min budget and contaminates the result with
`MerchantThrottlerGuard` rejections instead of measuring app capacity):

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Requests succeeded | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 |
| p50 latency | 3ms | 3ms | 3ms |
| p95 latency | 87.4ms | 7ms | 7ms |
| p99 latency | 320.6ms | 13.1ms | 15ms |
| max latency | 849ms | 55ms | 58ms |
| Error rate | 0% | 0% | 0% |

50,700 requests total, zero failures. Run 1's heavy tail is the same
cold-start pattern already seen elsewhere in this doc (2026-08-10's
Run 1) — this pass rebuilt the image and the database from nothing
immediately beforehand, colder than a typical re-run. Runs 2-3, once
warm, are tight and consistent with each other. **Conclusion: no
regression in success rate; once warm, latency is as good as or better
than every prior date in this section.** CPU (measured precisely, not
sampled) is covered below.

**Re-run 2026-08-24**, same rebuilt environment and same methodology
as the charge-path re-run above (200 seeded merchants, 200 payments
pre-seeded, one per merchant, `RATE_LIMIT_MAX`/`RATE_LIMIT_BURST_MAX`/
`AUTH_LOGIN_RATE_LIMIT` raised for setup and this run, restored to
defaults afterward). CPU measured the same way as the 2026-08-22 entry
below — `/proc/<pid>/stat`'s `utime+stime`, read immediately before
and after each run via `docker exec`, divided by that run's exact
wall-clock duration — not `docker stats` sampling:

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Requests succeeded | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 |
| p50 latency | 3ms | 3ms | 3ms |
| p95 latency | 6ms | 6ms | 6ms |
| p99 latency | 10.9ms | 10.9ms | 10.9ms |
| max latency | 84ms | 77ms | 54ms |
| Error rate | 0% | 0% | 0% |
| CPU, average | 23.32% (≈233m) | 23.15% (≈232m) | 23.11% (≈231m) |

50,700 requests total, zero failures. Memory spot-checked once after
all three runs: **61.85MiB** (≈12% of the 512Mi limit) — consistent
with the 2026-08-21 low-memory finding, not the higher ~104-127MiB
range seen on cold/earlier passes. No Run 1 cold-start tail this time
(p50/p95/p99 identical across all three runs, max latency actually
*decreasing* run-over-run) — plausibly because the charge-path
load-test run (seeding + Finding #1's own 6700 requests) immediately
beforehand had already warmed the JIT/connection pools before this
Finding's own Run 1 started, unlike prior passes that measured Finding
#2 cold. **Conclusion: no throughput, latency, or memory regression
from this round's per-merchant-PSP-entitlement work** — CPU (≈23%,
≈231-233m) sits between the 2026-08-21 outlier-low reading (≈1%,
never reproduced since, still retracted) and the 2026-08-22 reading
(≈26-27%), consistent with 2026-08-22's own conclusion that the
2026-08-21 figure remains an anomaly, not the new baseline.

## What this means for `k8s/hpa.yaml`

`k8s/deployment.yaml` requests 250m CPU / 256Mi memory per pod (limits:
1000m / 512Mi); `k8s/hpa.yaml` scales out at 70% CPU / 80% memory
**utilization against those requests** — not the limits. `docker stats`
during the read-capacity run (container capped at the deployment's
*limits*, 1 CPU / 512Mi):

| | Steady-state (150 req/s) | Peak |
|---|---|---|
| CPU | ~33–38% of 1 core (≈330–380m) | ~62% of 1 core (≈620m) |
| Memory | ~106–115MiB (≈21–22% of 512Mi limit) | 127.9MiB (≈25% of 512Mi limit) |

**Re-measured 2026-08-10** (NestJS v11 / Express 5, sampled every 3s
during Run 2/3 above — coarser sampling than the original pass, so the
true instantaneous peak may be understated here):

| | Steady-state (150 req/s) | Peak |
|---|---|---|
| CPU | ~26–47% of 1 core (≈260–470m), average ≈33% | ~47% of 1 core (≈470m) |
| Memory | ~108–120MiB (≈21–23% of 512Mi limit) | ~121MiB (≈24% of 512Mi limit) |

Same order of magnitude as the original pass — the CPU/memory footprint
of serving this read load didn't materially change with the upgrade.

**Re-measured 2026-08-21** (same dependency bumps + `uuid` removal as the
latency re-run above; sampled continuously via `docker stats` for the
duration of Run 3, not just spot-checked):

| | Steady-state (150 req/s, warm) | Peak |
|---|---|---|
| CPU | ~0.4–1.8% of 1 core (≈4–18m), average ≈1% | ~23% of 1 core (≈230m), during warm-up/ramp only |
| Memory | ~61–63MiB (≈12% of 512Mi limit) | ~104MiB (≈20% of 512Mi limit), during warm-up only |

A real drop, not noise: steady-state CPU went from ≈33% average
(≈330m) to ≈1% (≈10m) — roughly a 30x reduction — and steady-state
memory from ≈110–120MiB to ≈61–63MiB, roughly half. The peak in both
metrics now occurs during the warm-up/ramp phase (cold JIT, connection
pool still filling) and *drops* once the run reaches sustained 150 req/s,
the same cold-start pattern Run 1 showed in the latency numbers above —
just far more pronounced here since steady-state itself is now so cheap.
The likely driver: `crypto.randomUUID()` is a native Node binding (used
on every payment ID / correlation ID / event ID generation in the write
path, which this read-only benchmark doesn't even exercise directly, but
reflects the same runtime), versus the pure-JS `uuid` package's v4
implementation — consistent with the accumulated effect of this pass's
other dependency bumps rather than one single change.

Reframed against the HPA's actual basis (the 250m/256Mi **requests**):

- **CPU**: steady-state ≈140% of the 250m request, peak ≈250%. The HPA's
  70% target (175m) would trigger scale-out **well before** a single pod
  reaches anywhere near 150 req/s of read traffic — CPU is a genuinely
  conservative, early trigger at this request size, not a loose one.
- **Memory**: steady-state ≈43% of the 256Mi request, peak ≈50% — nowhere
  close to the 80% (205Mi) scale trigger even at sustained peak load.
  For this traffic shape, memory would essentially never be the thing
  that actually triggers a scale-out; CPU gets there first, by a wide
  margin.

**Conclusion**: the 70%/80% thresholds themselves aren't unreasonable, but
the *CPU request* (250m) is small enough relative to real per-pod
throughput that HPA would scale out fairly eagerly under read-heavy load —
worth knowing before assuming "70% CPU" means "close to actually
overloaded." This was previously undocumented; now there's a real,
reproducible number behind it instead of an untested default.

**Re-reframed 2026-08-21** against the same 250m/256Mi requests, using
the re-measured numbers above: steady-state CPU is now ≈4% of the 250m
request (≈10m/250m) and peak ≈92% (≈230m/250m, warm-up only, not
sustained). The "HPA would scale out fairly eagerly" conclusion above no
longer holds for this specific read workload — sustained 150 req/s alone
wouldn't get a pod anywhere near the 70% CPU trigger now. This doesn't
mean the HPA thresholds should change: it means this endpoint's resource
cost dropped enough that read traffic is no longer the thing likely to
drive scale-out — something else (the still-unmeasured charge path,
or a traffic mix heavier than pure reads) would need to be measured
before touching `k8s/hpa.yaml` or `k8s/deployment.yaml`'s requests.

**Re-measured 2026-08-22**, the same three runs reported under Finding
#2 above (the clean rebuild, superseding the earlier same-day pass that
ran on a host with a large unrelated Docker resource backlog — see
Finding #2). `docker stats`' 3–5s sampling interval proved too coarse
to trust for CPU on its own, so CPU here is read directly from the Node
process's accumulated time in `/proc/<pid>/stat` (`utime+stime`)
immediately before and after each run, divided by that run's exact
wall-clock duration — one deterministic average-CPU% per run, immune
to sampling-interval aliasing:

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| CPU, average | 32.7% (≈327m) | 26.3% (≈263m) | 26.7% (≈267m) |

Memory was spot-checked once after all three runs (~60MiB, idle) rather
than sampled continuously per run — consistent with the ~60–84MiB range
observed across every prior pass, not a precise per-run figure.

Run 1's CPU is elevated for the same cold-start reason its latency is
(fresh image, fresh database); Runs 2-3 settle to a tight, consistent
26–27%. **Conclusion: steady-state CPU is ≈26–27%, not the ≈1%
2026-08-21 recorded** — that figure still could not be reproduced,
even after eliminating both query logging and the earlier pass's
Docker-resource-backlog confound as possible causes, and remains
retracted as unreliable pending an explanation.

Reframed against the HPA's actual basis (the 250m/256Mi **requests**):
steady-state CPU (≈263–267m, ignoring the cold Run 1) sits at ≈105% of
the 250m request, comfortably past the 70% trigger (175m) before a pod
even reaches 150 req/s of read traffic alone — the original 2026-08-10
finding ("HPA would scale out fairly eagerly under sustained read
load") holds. Memory stays well under the 80% (205Mi) trigger — as in
every pass to date, memory is not what would drive scale-out for this
traffic shape.

**Re-measured 2026-08-24**, the same three runs reported under Finding
#2's 2026-08-24 entry, same `/proc/<pid>/stat` method as 2026-08-22
directly above:

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| CPU, average | 23.32% (≈233m) | 23.15% (≈232m) | 23.11% (≈231m) |

No cold Run 1 to discount this time (see Finding #2's 2026-08-24 entry
for why) — all three runs already reflect steady state. **Conclusion:
steady-state CPU is ≈23%, tighter and more consistent run-to-run than
either 2026-08-22's ≈26–27% or 2026-08-21's unreproduced ≈1% outlier,
but the same order of magnitude as 2026-08-22** — nothing this round's
application changes did shifted this measurably; the small (≈3–4
point) difference from 2026-08-22 reads as normal run-to-run/host
variance (see this doc's repeated warnings about host-level
contention confounding CPU readings), not a real regression or
improvement.

Reframed against the HPA's actual basis: steady-state CPU (≈231–233m)
sits at ≈92–93% of the 250m request — still comfortably past the 70%
trigger (175m) before a pod reaches 150 req/s of read traffic alone,
same conclusion as every prior dated entry in this section. Memory
(≈61.85MiB, ≈24% of the 256Mi request) stays well under the 80%
trigger, as always.

## Finding #3: PgBouncer adds no read-path cost, once it's actually resource-isolated

`docker-compose.yml`/`k8s/pgbouncer.yaml` put PgBouncer (transaction-mode
pooling) in front of both `postgres-master` and `postgres-replica`:
at `hpa.yaml`'s `maxReplicas: 20` × `extra.max: 20` per pod, direct
connections could reach 400 against a `max_connections=200` server,
independent of data volume.

**First two runs, against the same read-capacity methodology as above,
looked like a real regression**:

| Metric | Baseline (no PgBouncer) | Run 1 (PgBouncer, uncapped) | Run 2 (PgBouncer, uncapped) |
|---|---|---|---|
| Requests succeeded | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 |
| p99 latency | 10.9–13.9ms | 34.8ms | 16.9ms |
| max latency | 65–89ms | 233ms | 270ms |
| CPU peak | ~23% | ~64.5% | ~73.8% |
| Memory peak | ~104MiB | ~133MiB | ~125MiB |

Reproduced twice, so not noise — but the two `pgbouncer-*` containers
were running **unbounded** on the same host as `api`, `postgres-master`,
`postgres-replica`, `redis`, `vault`, and `mock-psp`. `api`'s own cgroup
was still capped at 1 CPU (matching `k8s/deployment.yaml`'s limits), but
two more actively-proxying containers competing for the same physical
cores plausibly explains elevated numbers on their own — a confound, not
evidence PgBouncer itself costs anything at the protocol level. (Same
class of mistake as the earlier `uuid`/`crypto.randomUUID()` numbers
above — different session, same lesson: a resource cap on the container
being measured doesn't control for what else is running on the host.)

**Re-run with `pgbouncer-master`/`pgbouncer-replica` capped to 0.5
CPU/128Mi each** (`docker update --cpus=0.5 --memory=128m` — matching
`k8s/pgbouncer.yaml`'s own `resources.limits`, so the local repro
actually matches what a real cluster would enforce per pod):

| Metric | Baseline (no PgBouncer) | **PgBouncer, capped to k8s limits** |
|---|---|---|
| Requests succeeded | 16,900/16,900 | **16,900/16,900** |
| p50 latency | 2–3ms | **2ms** |
| p95 latency | 6–7.9ms | **6ms** |
| p99 latency | 10.9–13.9ms | **10.1ms** |
| max latency | 65–89ms | **46ms** |
| CPU peak | ~23% | **~35.9%** |
| Memory peak | ~104MiB | **~112.8MiB** |

**Conclusion**: once PgBouncer is resource-isolated the way it actually
would be in the cluster (its own pod, its own `resources.limits`, not
competing unbounded with everything else), read-path latency and success
rate match or beat the no-pooler baseline. The uncapped runs' elevated
numbers were host-level container contention on the test machine, not a
PgBouncer-inherent cost — worth remembering if this gets re-tested on a
different machine and looks slow again: check what else is running
unbounded before concluding the pooler is the problem. CPU peak did go
up (~24% → ~36%) — plausibly the extra network hop's real, if modest,
cost — but stayed well within `k8s/deployment.yaml`'s 1000m limit and
didn't move p50/p95 or the success rate at all.

**Re-verified 2026-08-22**, on the same clean rebuild as Finding #2
above. Three consecutive runs with `api` pointed directly at
`postgres-master`/`postgres-replica` (`pgbouncer-master`/
`pgbouncer-replica` bypassed entirely — `DB_MASTER_HOST`/
`DB_REPLICA_HOST` aren't parameterized in `docker-compose.yml`, so this
needed a one-off `docker run` on the same network instead of the usual
Compose service), same CPU-jiffies method as Finding #2, immediately
compared against Finding #2's own three 2026-08-22 runs (which go
through PgBouncer, capped to `k8s/pgbouncer.yaml`'s 0.5 CPU/128Mi
limits, as always):

| Metric | Direct to Postgres, Run 1 | Run 2 | Run 3 | Via PgBouncer, Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|---|---|
| Requests succeeded | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 | 16,900/16,900 |
| p99 latency | 43.4ms | 13.1ms | 13.9ms | 320.6ms | 13.1ms | 15ms |
| max latency | 366ms | 95ms | 85ms | 849ms | 55ms | 58ms |
| CPU, average | 28.7% | 26.0% | 29.9% | 32.7% | 26.3% | 26.7% |

Zero failures either way — this isn't a capacity difference. Run 1 is
elevated on both sides (the same cold-start effect noted in Finding
#2); once warm, Runs 2-3 are close between the two conditions either
way, and don't reproduce the severe run-over-run degradation an
earlier same-day pass showed while bypassing PgBouncer — that pass ran
on a host with a large unrelated Docker resource backlog (see Finding
#2), and this clean rebuild doesn't show the same pattern.
**Conclusion: PgBouncer, capped to its real k8s resource limits,
remains not a read-path cost** — direct and pooled access perform
comparably once warm, consistent with the original 2026-08-10 finding.
The absolute CPU/latency levels on both sides are still well above the
2026-08-21 baseline (unreproduced, retracted as unreliable — see
Finding #2) — but the *relative* comparison this Finding exists to
make (PgBouncer vs. no PgBouncer) continues to hold the same direction
it always has.

## What this doesn't cover

- **The charge path's own ceiling is still unmeasured** — Finding #1
  explains why a single-IP load generator structurally can't get past the
  route-level cap. A real answer needs distributed source IPs.
- **The Postgres connection pool** (`extra.max: 20` in `app.module.ts`) was
  never visibly exhausted in these runs (no connection-wait errors, no
  latency cliff suggesting queuing) — but this is a **single pod**; 20
  connections against 150 req/s of point-reads, each holding a
  connection only briefly, isn't a strong test of that ceiling, and
  doesn't exercise the actual multi-pod scenario PgBouncer (Finding #3)
  was added for — 20 pods × 20 connections against one
  `max_connections=200` server. That scenario needs a real multi-replica
  test (HPA scaled out, not a single container), not yet done here.
- **Single instance only** — this is one pod's ceiling, not a
  multi-replica HPA simulation. Cross-replica behavior (Redis-backed
  circuit breaker/rate-limiter/idempotency state under real concurrent
  pods) is covered separately in
  [`distributed-state.md`](./distributed-state.md), not re-tested here.
- **mock-psp has no artificial latency** — these numbers reflect this
  app's own overhead (auth, DB, Redis) plus a near-instant PSP round trip,
  not what a real Stripe/Adyen call would add on top.
