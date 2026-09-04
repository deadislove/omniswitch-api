# Chaos Testing

`scripts/chaos/` injects real failures into the docker-compose stack —
stopping a real container mid-traffic, not mocking a dependency — to
check whether the resilience mechanisms this codebase documents (the
circuit breaker, fail-closed Redis-backed auth, connection-pool recovery)
actually hold up, the same "verify against real infrastructure, not just
code review" standard the rest of this project's testing already applies.
This is a different question from `load-testing.md`'s (sustained
throughput under normal conditions) — chaos testing asks what happens
*mid-operation failure*.

Each script is standalone, targets a running `docker-compose.yml` stack,
and needs credentials for a real seeded merchant (a MERCHANT-role
merchant for `psp-outage.sh`/`redis-outage.sh`/`postgres-primary-outage.sh`;
an OPERATOR-role merchant additionally for `psp-outage.sh`, to read
`GET /payments/routing/health`). See each script's own header for its
exact required environment variables. None of these are wired into CI —
deliberately destructive against real containers, not something to run
unattended on every push.

## `psp-outage.sh` — total PSP outage

Stops `mock-psp` (both `StripePSPAdapter` and `AdyenPSPAdapter` point at
the same container in this stack, so this is the "every PSP is
unreachable" case, not just one provider).

**What it proves**: sustained real failures trip `RedisCircuitBreakerService`
open; a charge attempted against a tripped/degraded PSP resolves as a
real business outcome (`FAILED`/`AMBIGUOUS`) with a bounded, non-hanging
response — not a 5xx crash or an indefinite hang; recovery is real once
the PSP comes back and the breaker's recovery window elapses.

**What running it actually found**: the circuit opens faster than
`FAILURE_THRESHOLD` (5) alone would suggest from a script issuing only 3
charge requests — `PaymentProcessorFactory.executeWithSmartRouting()`'s
own same-provider retry on an ambiguous outcome means each script-level
request can record more than one failure internally. A charge attempted
against a fully-down PSP resolves as `AMBIGUOUS`, not `FAILED` — a
connection failure with literally no response is exactly the case
`PaymentStatus.AMBIGUOUS` exists for (see that value object's own
docblock), confirmed here against a real dropped connection rather than
only the `pm_forcetimeoutalways`/socket-destroy markers the e2e suite
uses to simulate one.

## `redis-outage.sh` — Redis unreachable

Stops `redis` while holding a real, already-issued, unexpired JWT, then
retries the same token.

**What it proves**: `security-and-compliance.md`'s documented trade-off —
"Redis becomes a hard dependency for authentication... fails closed
rather than open" — actually holds. A valid JWT must be *rejected* while
Redis is down, not silently accepted because the revocation check
couldn't run.

**What running it actually found**: the fail-closed behavior is real (a
valid token is rejected, not accepted), but it surfaces as a generic
`500 Internal Server Error` rather than a purpose-built `503`/`401` with
a clear error code — the Redis connection failure is an uncaught
exception propagating out of the revocation check, not a deliberately
thrown, documented failure mode. The *security* property holds; the
*operational* clarity doesn't — an on-call engineer seeing bare 500s
across the board has to already know about this specific trade-off to
recognize "Redis is down" as the cause rather than treating it as an
unrelated crash. Worth a follow-up: catch the Redis-unreachable case in
`JwtStrategy.validate()` specifically and return a `503` with a
`code: 'REVOCATION_CHECK_UNAVAILABLE'`-shaped body instead of letting it
fall through to Nest's generic 500 handler.

## `postgres-primary-outage.sh` — Postgres primary unreachable

Stops `postgres-master` (every write goes here; plain reads route to
`postgres-replica` — see `app.module.ts`'s `replication` config), attempts
a charge (a write) with a bounded `--max-time`, then restarts it.

**What it proves**: a write attempted while the primary is down fails
within a bounded time instead of hanging the request indefinitely, and
TypeORM's connection pool reconnects on its own once the primary comes
back — no app restart required to recover.

**What running it actually found**: a write attempted against a stopped
primary doesn't fail fast — it hangs for the script's full 15s
`--max-time` budget with no response at all (curl exit 28, a client-side
timeout), rather than a quick connection-refused. The pooled connections
already open to `postgres-master` sit waiting on a query response that
will never come, instead of detecting the dead socket and failing
immediately — worth a look at whether a `statement_timeout`/TCP
keepalive setting tighter than "however long the caller is willing to
wait" belongs on this connection. Recovery is real but not instant
either: the first couple of write attempts *after* `docker compose ps`
already reports `postgres-master` healthy again still fail (`500`) —
the app's own connection pool needs a further handful of failed
attempts (tens of seconds, in the run that produced this) to discard
its stale connections and re-establish new ones before writes succeed
again. Both gaps are about *how long* recovery takes, not whether it
happens — no request was ever silently lost or double-processed, and no
restart of the `api` process was needed either time.

Deliberately does not attempt to kill the primary *mid-transaction*
(precise timing against a real external process isn't reliably
scriptable) — this covers the coarser "primary unreachable for the whole
request" case, which is still a real, useful signal about failure mode
and recovery time.

## What this doesn't cover

- **Mid-transaction kills** (the primary dying between two statements of
  the same DB transaction) — not exercised by `postgres-primary-outage.sh`,
  for the timing reason above.
- **Network partitions that aren't a clean stop/start** (e.g. a container
  that's up but unreachable — packet loss, one-directional partition)
  behave differently from a stopped container (immediate connection
  refusal vs. a hanging connection attempt) and aren't exercised here.
- **Concurrent multi-fault scenarios** (e.g. Redis *and* a PSP down at
  the same time) — each script tests one fault in isolation.
- **Replica failover** — `postgres-primary-outage.sh` covers the primary;
  what happens to read traffic if `postgres-replica` itself goes down
  isn't separately scripted (reads would fall back to whatever
  `app.module.ts`'s `replication` config does when the replica pool has
  no healthy connection — not verified here).
