import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stage 1 of the payments/ledger_outbox partitioning migration.
 *
 * Creates NEW, empty, range-partitioned tables (`payments_partitioned`,
 * `ledger_outbox_partitioned`) — deliberately staging-named, not yet the
 * live `payments`/`ledger_outbox` tables. The actual backfill of
 * existing rows and the atomic rename-swap into the live table names is
 * a separate, later migration (task #9): a straight `INSERT ... SELECT`
 * backfill at real data volume is a long-running, closely-supervised
 * operation that shouldn't be bundled into the same migration as the
 * schema change itself — if the backfill needs to be retried or done in
 * batches, this migration (the structure) should already be safely
 * applied and not need re-running.
 *
 * Partitioned by month on `created_at`, matching the design's pairing
 * with the 180-day archive policy (Option 3) — once archiving is live,
 * `payments`/`ledger_outbox` only ever hold ~6-7 months of partitions
 * at steady state, which is what keeps the per-partition-index cost on
 * id/status-keyed lookups negligible (benchmarked in the same doc,
 * Option 2's query audit).
 *
 * Initial partitions are computed relative to *whenever this migration
 * actually runs*, not a hardcoded calendar range — a fresh clone of this
 * repo, run months or years from now, must still get partitions that
 * cover the current month, not stale ones frozen at whenever this file
 * was written. 6 months back (backdated headroom for the eventual
 * backfill in task #9, and matching the archive-driven ~6-7 month live
 * window) through 2 months forward (buffer) = 9 partitions. A `DEFAULT`
 * partition catches anything outside that range so an INSERT never
 * hard-fails with "no partition found" the way it would without one.
 * Rows landing in the DEFAULT partition are a signal that
 * partition-maintenance (creating next month's partition ahead of time)
 * has fallen behind — this migration only creates the *initial* set;
 * the recurring maintenance itself is `create-partitions-job.ts`, run
 * as `k8s/partition-maintenance-cronjob.yaml`.
 *
 * Primary key / unique constraints both include `created_at` — Postgres
 * requires this for any partitioned table's PK/unique constraints (see
 * Option 2's constraint-change table). `idempotency_key` moves from a
 * standalone UNIQUE to `(idempotency_key, created_at)` — safe, since an
 * idempotency key is only ever checked relative to when it was issued,
 * not globally-ever.
 *
 * Task 8c — query-audit sign-off (Option 2's "not partition-pruning-safe"
 * list: PaymentEntity's findById()/findByIdOnMaster()/
 * findByIdempotencyKey()/findByPspTransactionId()/countByStatusAndProvider(),
 * LedgerOutboxEntity's findPending()/markPublished()/markFailed()/findById()/
 * findFailed()/resetToPending()/countByStatus()). These are confirmed safe
 * to leave as-is post-partitioning, not a follow-up to fix: benchmarked
 * 2026-08-21 against 700k rows flat vs. the same rows across 7 monthly
 * partitions — id-keyed UPDATE delta ~0.005ms/op, status-keyed SELECT delta
 * ~0.0016ms/op, both negligible at this design's bounded partition count
 * (~6-7, per Option 3's 180-day archive window). No code change needed in
 * payment-typeorm.repository.ts for these methods.
 */
export class CreatePartitionedPaymentsAndLedgerOutbox1787325352938 implements MigrationInterface {
    name = 'CreatePartitionedPaymentsAndLedgerOutbox1787325352938'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ─── payments_partitioned ──────────────────────────────────────
        // Same columns/types/defaults as "payments" (reuses the existing
        // "payments_status_enum" type — no need for a second copy of it).
        await queryRunner.query(`
            CREATE TABLE "payments_partitioned" (
                "id" uuid NOT NULL,
                "merchant_id" character varying NOT NULL,
                "customer_id" character varying,
                "order_id" character varying,
                "amount_minor_units" bigint NOT NULL,
                "currency_code" character varying(3) NOT NULL,
                "currency_minor_units" integer NOT NULL,
                "status" "public"."payments_status_enum" NOT NULL DEFAULT 'PENDING',
                "idempotency_key" character varying NOT NULL,
                "psp_provider" character varying,
                "psp_transaction_id" character varying,
                "psp_raw_response" jsonb,
                "risk_score" integer,
                "three_ds_result" jsonb,
                "refunds" jsonb NOT NULL DEFAULT '[]',
                "captures" jsonb NOT NULL DEFAULT '[]',
                "failure_reason" character varying,
                "failure_code" character varying,
                "description" character varying,
                "statement_descriptor" character varying,
                "payment_metadata" jsonb,
                "bin_info" jsonb,
                "fx_snapshot" jsonb,
                "settlement_conversion" jsonb,
                "splits" jsonb,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_payments_partitioned" PRIMARY KEY ("id", "created_at"),
                CONSTRAINT "UQ_payments_partitioned_idempotency_key" UNIQUE ("idempotency_key", "created_at")
            ) PARTITION BY RANGE ("created_at")
        `);

        // Indexes on the parent automatically propagate to every
        // partition (PG 11+) and to any partition created later.
        await queryRunner.query(`CREATE INDEX "IDX_payments_partitioned_merchant_id" ON "payments_partitioned" ("merchant_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_payments_partitioned_merchant_created" ON "payments_partitioned" ("merchant_id", "created_at")`);
        await queryRunner.query(`CREATE INDEX "IDX_payments_partitioned_status" ON "payments_partitioned" ("status")`);
        await queryRunner.query(`CREATE INDEX "IDX_payments_partitioned_psp_transaction_id" ON "payments_partitioned" ("psp_transaction_id")`);

        // ─── ledger_outbox_partitioned ─────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE "ledger_outbox_partitioned" (
                "id" uuid NOT NULL,
                "payment_id" character varying NOT NULL,
                "event_type" character varying NOT NULL,
                "entries" jsonb NOT NULL,
                "status" character varying NOT NULL DEFAULT 'PENDING',
                "retry_count" integer NOT NULL DEFAULT '0',
                "last_error" character varying,
                "processed_at" TIMESTAMP,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_ledger_outbox_partitioned" PRIMARY KEY ("id", "created_at")
            ) PARTITION BY RANGE ("created_at")
        `);

        await queryRunner.query(`CREATE INDEX "IDX_ledger_outbox_partitioned_payment_id" ON "ledger_outbox_partitioned" ("payment_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_ledger_outbox_partitioned_status_created" ON "ledger_outbox_partitioned" ("status", "created_at")`);

        // ─── Partitions: 6 months back through 2 months forward of
        // *whenever this migration actually runs*, plus a DEFAULT
        // catch-all. `Date.UTC` normalizes month over/underflow on its
        // own (e.g. month index -1 correctly rolls back into December of
        // the prior year), so this handles year boundaries for free.
        const monthStart = (offset: number, ref: Date = new Date()) =>
            new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + offset, 1));
        const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
        const toSuffix = (d: Date) => `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

        const now = new Date();
        for (let offset = -6; offset <= 2; offset++) {
            const from = monthStart(offset, now);
            const to = monthStart(offset + 1, now);
            const suffix = toSuffix(from);
            await queryRunner.query(
                `CREATE TABLE "payments_partitioned_${suffix}" PARTITION OF "payments_partitioned" FOR VALUES FROM ('${toDateStr(from)}') TO ('${toDateStr(to)}')`,
            );
            await queryRunner.query(
                `CREATE TABLE "ledger_outbox_partitioned_${suffix}" PARTITION OF "ledger_outbox_partitioned" FOR VALUES FROM ('${toDateStr(from)}') TO ('${toDateStr(to)}')`,
            );
        }
        await queryRunner.query(`CREATE TABLE "payments_partitioned_default" PARTITION OF "payments_partitioned" DEFAULT`);
        await queryRunner.query(`CREATE TABLE "ledger_outbox_partitioned_default" PARTITION OF "ledger_outbox_partitioned" DEFAULT`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Dropping a partitioned parent table in Postgres automatically
        // drops every partition attached to it — no need to drop each
        // "_2026_XX" / "_default" child individually.
        await queryRunner.query(`DROP TABLE "ledger_outbox_partitioned"`);
        await queryRunner.query(`DROP TABLE "payments_partitioned"`);
    }

}
