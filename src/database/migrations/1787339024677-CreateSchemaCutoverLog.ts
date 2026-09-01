import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Tracks when `payments_old`/`ledger_outbox_old` (the pre-partitioning
 * flat tables, kept as a safety net by
 * `1787333739819-BackfillAndSwapPartitionedPaymentsAndLedgerOutbox.ts`)
 * became redundant — see docs/compliance/data-retention.md's "Cutover
 * safety-net tables" section for the full reasoning.
 *
 * TypeORM's own `typeorm_migrations` table only stores each migration's
 * version number (the filename timestamp), not the real wall-clock time
 * it actually executed — there's no built-in way to answer "how long
 * ago did the cutover happen" from that table alone. This is the
 * dedicated record for that instead: `src/jobs/drop-cutover-tables.ts`
 * reads it to decide whether the configured retention window
 * (`CUTOVER_OLD_TABLE_RETENTION_DAYS`) has elapsed.
 *
 * This migration runs after the cutover already happened in this
 * project's history — ideally the cutover migration itself would have
 * written this row at the moment of the rename, but that migration is
 * already applied everywhere and migrations are not something this
 * codebase edits after the fact (see database-migrations.md). `now()`
 * here is the practical stand-in: close enough to the actual cutover
 * time for a 60-day verification window to mean what it's supposed to,
 * and the honest, auditable alternative to guessing or hardcoding a
 * past date.
 */
export class CreateSchemaCutoverLog1787339024677 implements MigrationInterface {
    name = 'CreateSchemaCutoverLog1787339024677'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "schema_cutover_log" (
                "table_name" character varying NOT NULL,
                "cutover_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT "PK_schema_cutover_log" PRIMARY KEY ("table_name")
            )
        `);
        await queryRunner.query(
            `INSERT INTO "schema_cutover_log" ("table_name", "cutover_at") VALUES ('payments_old', now()), ('ledger_outbox_old', now())`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "schema_cutover_log"`);
    }

}
