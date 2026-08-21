import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cold storage for Option 3's archiving tier (Phase 3, task 10b — see
 * docs/spec/future/database-scaling.md Option 3). A separate Postgres
 * *schema* (not a separate database) — same instance, same backup/HA
 * story, no new vendor or connection to manage, per the design doc's
 * "stay inside the Postgres ecosystem" reasoning.
 *
 * `archive.payments` / `archive.ledger_outbox` are deliberately flat,
 * not partitioned — cold storage is written to rarely (once per
 * archiving run) and read even more rarely (an audit/compliance lookup,
 * not a hot query path), so the vacuum/bloat problem partitioning exists
 * to solve doesn't apply here the way it does to the live tables.
 *
 * Columns mirror the live `payments`/`ledger_outbox` tables exactly,
 * plus one addition: `archived_at`, so a record's own row says when it
 * left the hot path — useful for an audit trail without needing to
 * cross-reference the archiving job's logs.
 */
export class CreateArchiveSchema1787334795968 implements MigrationInterface {
    name = 'CreateArchiveSchema1787334795968'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "archive"`);

        await queryRunner.query(`
            CREATE TABLE "archive"."payments" (
                "id" uuid NOT NULL,
                "merchant_id" character varying NOT NULL,
                "customer_id" character varying,
                "order_id" character varying,
                "amount_minor_units" bigint NOT NULL,
                "currency_code" character varying(3) NOT NULL,
                "currency_minor_units" integer NOT NULL,
                "status" character varying NOT NULL,
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
                "created_at" TIMESTAMP NOT NULL,
                "updated_at" TIMESTAMP NOT NULL,
                "archived_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT "PK_archive_payments" PRIMARY KEY ("id")
            )
        `);
        // Looked up by merchant/id for the rare audit/compliance query, and
        // by created_at to find records approaching the deletion tier's
        // age threshold — not by anything requiring a hot-path index.
        await queryRunner.query(`CREATE INDEX "IDX_archive_payments_merchant_id" ON "archive"."payments" ("merchant_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_archive_payments_created_at" ON "archive"."payments" ("created_at")`);

        await queryRunner.query(`
            CREATE TABLE "archive"."ledger_outbox" (
                "id" uuid NOT NULL,
                "payment_id" character varying NOT NULL,
                "event_type" character varying NOT NULL,
                "entries" jsonb NOT NULL,
                "status" character varying NOT NULL,
                "retry_count" integer NOT NULL,
                "last_error" character varying,
                "processed_at" TIMESTAMP,
                "created_at" TIMESTAMP NOT NULL,
                "archived_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT "PK_archive_ledger_outbox" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_archive_ledger_outbox_payment_id" ON "archive"."ledger_outbox" ("payment_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "archive"."ledger_outbox"`);
        await queryRunner.query(`DROP TABLE "archive"."payments"`);
        await queryRunner.query(`DROP SCHEMA "archive"`);
    }

}
