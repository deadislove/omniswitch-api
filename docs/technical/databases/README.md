# Databases

Everything about this project's PostgreSQL schema and physical
database architecture — as opposed to
[`../database-migrations.md`](../database-migrations.md), which covers
the migration *workflow* (how a schema change gets from an entity file
to a running database), or [`../jobs.md`](../jobs.md), which covers the
background jobs that operate on this schema. Start here if you're
trying to answer "what does the schema actually look like" or "how is
this database deployed/scaled," not "how do I write a migration."

- [`erd.md`](./erd.md) — entity-relationship diagram and how tables
  reference each other (note up front: this project has **no
  database-level foreign key constraints** — every reference below is
  application-enforced, and the diagram explains why)
- [`schema.md`](./schema.md) — table-by-table reference: what each
  table is for, which schema it lives in (`public` vs `archive`), and
  where to find its authoritative column list (the entity file, not a
  hand-maintained copy here)
- [`architecture.md`](./architecture.md) — the physical deployment:
  master/replica streaming replication, PgBouncer connection pooling in
  front of both, and `payments`/`ledger_outbox` table partitioning
- [`maintenance.md`](./maintenance.md) — recurring and one-time
  operational tasks against this database (migrations, partition
  maintenance, archiving/deletion, the partitioning-cutover cleanup)
  and where each one is actually documented in full

## Single database, single Postgres cluster

There is exactly one logical database (`omniswitch_payments`), one
primary (`postgres-master`) with one streaming-replication read replica
(`postgres-replica`) — no sharding, no separate databases per module or
per tenant. Every table in [`schema.md`](./schema.md) lives in this one
database, in one of two schemas: `public` (live, hot-path tables) or
`archive` (cold storage for the data-retention policy — see
[`../../compliance/data-retention.md`](../../compliance/data-retention.md)).
This is a deliberate scope boundary: multi-database/Citus-style
horizontal scaling was evaluated and explicitly deferred — see
[`architecture.md`](./architecture.md#why-not-a-distributed-database)
for why.
