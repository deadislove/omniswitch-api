# Physical Database Architecture

How this database is actually deployed and scaled — replication,
connection pooling, and table partitioning. All three were evaluated
together in `docs/spec/future/database-scaling.md` (local-only, not
tracked in git) as Options 1–3; this doc is the tracked, public-facing
record of what actually got built from that proposal.

## Master/replica streaming replication

One primary (`postgres-master`), one streaming-replication read replica
(`postgres-replica`) — physical (WAL-based) replication, not logical.
The app's own `TypeOrmModule.forRootAsync()` (`app.module.ts`) opens
**two separate connection pools**: one at `DB_MASTER_HOST` for writes
(and any read that needs read-after-write consistency), one at
`DB_REPLICA_HOST` for reads that can tolerate replication lag.
`PaymentTypeOrmRepository` is the main place this split matters — see
its `findByIdOnMaster()` vs `findById()` methods, used specifically
where a request needs to read back a row it (or a very recent request)
just wrote.

The replica is read-only at the Postgres level (`hot_standby`) — it
can never accept a write, so there's no split-brain risk from
accidentally routing a write there. Replication lag is real but
unbounded-in-theory; code paths reading from the replica need to be
correct under "this row might be a few hundred milliseconds stale," not
assume synchronous consistency.

## PgBouncer — connection pooling in front of both

`k8s/pgbouncer.yaml` deploys two separate PgBouncer Deployments,
`pgbouncer-master` and `pgbouncer-replica`, each in `transaction`
pooling mode (`POOL_MODE: transaction`) with `DEFAULT_POOL_SIZE: 50`.
The app connects to these, never directly to `postgres-master`/
`postgres-replica` — `DB_MASTER_HOST`/`DB_REPLICA_HOST` in
`k8s/configmap.yaml` point at the poolers, not the real Postgres
backends (`PGBOUNCER_MASTER_BACKEND_HOST`/`PGBOUNCER_REPLICA_BACKEND_HOST`
is where the poolers themselves point).

**Why this exists**: each API pod opens up to `extra.max: 20`
connections per pool (`app.module.ts`) — one pool for master, one for
replica. At `k8s/hpa.yaml`'s `maxReplicas: 20`, that's up to 400
potential connections against each of master and replica, both
configured for `max_connections=200` in the local docker-compose stack.
The math is over budget at full HPA scale independent of data volume —
this isn't a symptom that shows up only under load, it's a hard ceiling
the raw connection count would hit. PgBouncer's transaction-mode
pooling multiplexes many client (app-pod) connections onto a bounded
number of real backend connections (`DEFAULT_POOL_SIZE: 50` per
instance, well under the 200 budget, leaving headroom for replication
streams, migrations, and admin tooling).

**Load-tested, not just configured**: see
[`../load-testing.md`](../load-testing.md) (Finding #3) for a real
throughput/latency comparison against the actual production Docker
image, resource-capped to `k8s/pgbouncer.yaml`'s own 0.5 CPU/128Mi
limits — PgBouncer matches or beats the pre-PgBouncer baseline, not
just "doesn't obviously break things."

**Migrations bypass the pooler.** `src/database/data-source.ts` (the
CLI `DataSource` used by `migration:run`/`migration:generate`) points
at `postgres-master`'s own port directly in local/dev, not
`pgbouncer-master`. DDL and transaction-mode pooling don't mix well
(a pooled connection can be handed to a different logical session
mid-transaction in ways that interact badly with certain DDL patterns),
and migrations aren't the connection-*count* problem PgBouncer exists
to solve in the first place — see
[`../database-migrations.md`](../database-migrations.md).

## Partitioning

`payments` and `ledger_outbox` are Postgres **declarative range
partitions**, partitioned by `created_at`, one partition per calendar
month. This was a two-stage migration, not a single step — worth
understanding both stages if you're reading the schema or the
migration files directly:

**Stage 1** (`1787325352938-CreatePartitionedPaymentsAndLedgerOutbox.ts`)
created new, empty, correctly-partitioned tables under staging names
(`payments_partitioned`, `ledger_outbox_partitioned`) — not yet the
live tables. Primary keys and unique constraints both had to include
`created_at` (`PRIMARY KEY ("id", "created_at")`) — Postgres requires
the partition key to be part of any PK/unique constraint on a
partitioned table. `idempotency_key` moved from a standalone `UNIQUE`
to `UNIQUE ("idempotency_key", "created_at")` for the same reason —
safe, since an idempotency key is only ever checked relative to when it
was issued.

**Stage 2** (`1787333739819-BackfillAndSwapPartitionedPaymentsAndLedgerOutbox.ts`)
backfilled every existing row via `INSERT ... SELECT`, verified the row
counts matched before proceeding, then atomically renamed the old flat
tables to `payments_old`/`ledger_outbox_old` and the new partitioned
tables into the live `payments`/`ledger_outbox` names — all inside one
migration transaction, so the app is never left pointed at a table that
doesn't exist under the expected name. No entity or repository code
changed for this cutover: TypeORM maps by table name, not by which
physical table happens to hold it, so `PaymentEntity`/
`PaymentTypeOrmRepository` kept working unmodified.

**The rename doesn't cascade to child partitions — this is the single
most important gotcha if you're reading the schema directly.** Stage
2's `ALTER TABLE payments_partitioned RENAME TO payments` renames only
the *parent* table. Postgres does not propagate that rename to the
child partitions attached to it, so every partition created since
(and every partition Stage 1 itself created) is named
`payments_partitioned_YYYY_MM` / `ledger_outbox_partitioned_YYYY_MM` —
**not** `payments_YYYY_MM` — even though the parent tables are
`payments`/`ledger_outbox`. `src/jobs/create-partitions-job.ts` matches
this naming deliberately; an earlier draft of that job used
`payments_YYYY_MM` and failed immediately with `"partition ... would
overlap partition \"payments_partitioned_2026_08\""` the first time it
ran against the real cutover schema.

**Partition maintenance is a separate, ongoing job, not part of either
migration above.** Stage 1 only pre-created partitions for a fixed
window relative to when *it* ran (6 months back, 2 forward) — nothing
in either migration keeps extending that window as real time moves
past it. `src/jobs/create-partitions-job.ts` (a weekly CronJob) does
that; see [`../jobs.md`](../jobs.md) and
[`../../guide/jobs/partition-maintenance.md`](../../guide/jobs/partition-maintenance.md).
Falling behind on this doesn't error — new rows silently land in the
`DEFAULT` partition instead of a real monthly one, quietly losing the
partitioning benefit for those rows (no query pruning, no bounded
per-partition index size) with no visible failure.

**Why partitioning at all, and why monthly**: paired with the 180-day
default archive threshold (see
[`../../compliance/data-retention.md`](../../compliance/data-retention.md)),
`payments`/`ledger_outbox` only hold roughly 6–7 months of partitions
at steady state once archiving is running continuously — that's what
keeps per-partition index size (and therefore id/status-keyed lookup
cost) bounded regardless of how much total history this deployment
accumulates. The design doc's query audit benchmarked this directly:
700k rows flat vs. the same rows spread across 7 monthly partitions
showed a negligible delta (~0.005ms/op on an id-keyed `UPDATE`,
~0.0016ms/op on a status-keyed `SELECT`) at this partition count — the
win compounds as total historical volume grows, since the *flat* table
would keep growing while the *partitioned* one stays bounded by the
retention policy.

### The `archive` schema

Cold storage for the data-retention policy — a separate Postgres
*schema* (`archive.payments`, `archive.ledger_outbox`), not a separate
database, deliberately: same instance, same backup/HA story as the
live tables, no new vendor or connection pool to manage. Unlike
`public.payments`/`public.ledger_outbox`, the `archive.*` tables are
**flat, not partitioned** — cold storage is written to rarely (once per
archiving run) and read even more rarely (an audit/compliance lookup,
not a hot query path), so the vacuum/bloat problem partitioning exists
to solve doesn't apply to it the way it does to the live tables. See
[`schema.md`](./schema.md#archive-schema--cold-storage) for the
`varchar`-vs-`enum` type difference this introduces on the `status`
column.

## Why not a distributed database

`docs/spec/future/database-scaling.md` (local-only) evaluated Citus
(distributed Postgres, sharded across nodes) as a fourth option beyond
pooling/partitioning/retention, specifically to handle write throughput
and data volume past what a single primary can hold — and explicitly
deferred it. The short version: PgBouncer (Option 1) and partitioning +
retention (Options 2–3) address this project's actual measured
bottlenecks (connection count at HPA scale, unbounded table growth) at
its current and reasonably-projected data volume, without taking on a
distributed system's operational complexity (rebalancing, cross-shard
transactions, a second thing to run and monitor). Citus remains
proposal-stage — a real deployment outgrowing a single primary even
after partitioning/retention/pooling are all in place is the trigger
condition for revisiting it, not a default assumption that it's coming
next.
