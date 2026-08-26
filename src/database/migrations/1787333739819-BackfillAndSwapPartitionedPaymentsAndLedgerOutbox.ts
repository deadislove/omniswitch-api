import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stage 2 of the payments/ledger_outbox partitioning migration.
 *
 * Stage 1 (`1787325352938-CreatePartitionedPaymentsAndLedgerOutbox.ts`)
 * created empty, correctly-partitioned staging tables. This migration
 * backfills them with every existing row, then atomically swaps table
 * names so the partitioned tables become the live `payments`/
 * `ledger_outbox` that the app's entities already point at — no entity
 * or repository code change needed, since TypeORM maps by table name,
 * not by which physical table happens to hold it.
 *
 * The old (flat) tables are renamed to `_old`, not dropped — kept as a
 * safety net for a verification period after cutover, consistent with
 * this project's "no deletion without a separate, explicit decision"
 * stance (see Option 3's archiving policy for the same principle applied
 * elsewhere). Dropping them is a deliberate follow-up, not part of this
 * migration.
 *
 * `TRUNCATE` on the partitioned tables at the start of `up()` (cascades
 * to every partition) makes this migration safe to `revert`+`run` again
 * during testing — without it, a second `up()` after a `down()` would
 * try to re-insert rows whose `(id, created_at)` already exist from the
 * first run (the old table' data doesn't change, `down()` doesn't clear
 * the partitioned tables either), hitting the primary key constraint.
 *
 * At this project's current data volume (thousands of rows, not
 * 100M+), a single `INSERT ... SELECT` is fine. At real production
 * scale this step needs batching and would be a genuinely long-running,
 * closely-supervised operation — see Option 2's note on this in
 * database-scaling.md. This migration is the reference shape of that
 * runbook, not a batching implementation.
 */
export class BackfillAndSwapPartitionedPaymentsAndLedgerOutbox1787333739819 implements MigrationInterface {
    name = 'BackfillAndSwapPartitionedPaymentsAndLedgerOutbox1787333739819'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Idempotent re-run safety — see docblock. Cascades to every
        // partition of the parent table.
        await queryRunner.query(`TRUNCATE TABLE "payments_partitioned"`);
        await queryRunner.query(`TRUNCATE TABLE "ledger_outbox_partitioned"`);

        // ─── Backfill ───────────────────────────────────────────────────
        // Explicit column lists on both sides — order-independent and
        // resistant to future column-order drift, unlike `SELECT *`.
        await queryRunner.query(`
            INSERT INTO "payments_partitioned" (
                "id", "merchant_id", "customer_id", "order_id", "amount_minor_units",
                "currency_code", "currency_minor_units", "status", "idempotency_key",
                "psp_provider", "psp_transaction_id", "psp_raw_response", "risk_score",
                "three_ds_result", "refunds", "captures", "failure_reason", "failure_code",
                "description", "statement_descriptor", "payment_metadata", "bin_info",
                "fx_snapshot", "settlement_conversion", "splits", "created_at", "updated_at"
            )
            SELECT
                "id", "merchant_id", "customer_id", "order_id", "amount_minor_units",
                "currency_code", "currency_minor_units", "status", "idempotency_key",
                "psp_provider", "psp_transaction_id", "psp_raw_response", "risk_score",
                "three_ds_result", "refunds", "captures", "failure_reason", "failure_code",
                "description", "statement_descriptor", "payment_metadata", "bin_info",
                "fx_snapshot", "settlement_conversion", "splits", "created_at", "updated_at"
            FROM "payments"
        `);

        await queryRunner.query(`
            INSERT INTO "ledger_outbox_partitioned" (
                "id", "payment_id", "event_type", "entries", "status",
                "retry_count", "last_error", "processed_at", "created_at"
            )
            SELECT
                "id", "payment_id", "event_type", "entries", "status",
                "retry_count", "last_error", "processed_at", "created_at"
            FROM "ledger_outbox"
        `);

        // ─── Verify before cutover — refuse to swap on a row-count
        // mismatch rather than silently going live on a partial backfill.
        const [paymentsCheck] = await queryRunner.query(
            `SELECT (SELECT count(*) FROM "payments") AS old_count, (SELECT count(*) FROM "payments_partitioned") AS new_count`,
        );
        if (paymentsCheck.old_count !== paymentsCheck.new_count) {
            throw new Error(
                `payments backfill row-count mismatch: payments=${paymentsCheck.old_count}, payments_partitioned=${paymentsCheck.new_count}`,
            );
        }
        const [outboxCheck] = await queryRunner.query(
            `SELECT (SELECT count(*) FROM "ledger_outbox") AS old_count, (SELECT count(*) FROM "ledger_outbox_partitioned") AS new_count`,
        );
        if (outboxCheck.old_count !== outboxCheck.new_count) {
            throw new Error(
                `ledger_outbox backfill row-count mismatch: ledger_outbox=${outboxCheck.old_count}, ledger_outbox_partitioned=${outboxCheck.new_count}`,
            );
        }

        // ─── Atomic cutover ─────────────────────────────────────────────
        // Runs inside this migration's transaction (TypeORM wraps each
        // migration in one by default) — either every rename below lands,
        // or none do; the app is never left pointed at a table that
        // doesn't exist under the "payments"/"ledger_outbox" name.
        await queryRunner.query(`ALTER TABLE "payments" RENAME TO "payments_old"`);
        await queryRunner.query(`ALTER TABLE "payments_partitioned" RENAME TO "payments"`);
        await queryRunner.query(`ALTER TABLE "ledger_outbox" RENAME TO "ledger_outbox_old"`);
        await queryRunner.query(`ALTER TABLE "ledger_outbox_partitioned" RENAME TO "ledger_outbox"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Swap back — restores the original flat tables as the live
        // "payments"/"ledger_outbox". The now-unused partitioned tables
        // (still holding the backfilled copy) go back to their staging
        // names, ready for `up()` to TRUNCATE and re-backfill cleanly.
        await queryRunner.query(`ALTER TABLE "ledger_outbox" RENAME TO "ledger_outbox_partitioned"`);
        await queryRunner.query(`ALTER TABLE "ledger_outbox_old" RENAME TO "ledger_outbox"`);
        await queryRunner.query(`ALTER TABLE "payments" RENAME TO "payments_partitioned"`);
        await queryRunner.query(`ALTER TABLE "payments_old" RENAME TO "payments"`);
    }

}
