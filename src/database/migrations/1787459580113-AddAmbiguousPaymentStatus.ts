import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds AMBIGUOUS to payments_status_enum — see PaymentStatus.AMBIGUOUS's
 * own docblock for why: a PSP call that gets no response at all (timeout,
 * connection drop), even after one same-provider retry via idempotency
 * replay, leaves this system genuinely unable to tell whether the charge
 * happened — a different outcome from FAILED, which only ever means "the
 * PSP explicitly said no" or "never reached a PSP at all." Same
 * rename-recreate-swap pattern as 1786125867991-AddPartialCaptureSupport.ts,
 * since Postgres doesn't support adding one value to an enum type and
 * altering a column's default/constraints in the same statement set
 * cleanly across both directions of a migration.
 *
 * payments_old (the pre-partitioning cutover safety-net table — see
 * 1787333739819-BackfillAndSwapPartitionedPaymentsAndLedgerOutbox.ts and
 * docs/compliance/data-retention.md) shares the SAME Postgres enum type
 * object for its own status column, not a separate copy — renaming
 * payments_status_enum renames what payments_old.status points at too,
 * so DROP TYPE ..._old fails with "other objects depend on it" unless
 * payments_old.status is detached first.
 * payments_old is deprecated and read only by drop-cutover-tables.ts via
 * raw SQL (no TypeORM entity), so converting its status column to plain
 * varchar — the same type archive.payments.status already uses — is
 * simpler than keeping it pinned to an enum only this one legacy table
 * still needs. Guarded with an existence check since payments_old may
 * already have been dropped (CUTOVER_OLD_TABLE_RETENTION_DAYS elapsed)
 * by the time this migration — or its down() — actually runs. The
 * column's own DEFAULT clause is a second, separate dependency on the
 * enum type beyond the column's data type itself — dropping only the
 * type dependency and leaving the default in place still fails, so both
 * are dropped here rather than carried forward, since nothing inserts
 * into this frozen historical snapshot table anymore.
 */
export class AddAmbiguousPaymentStatus1787459580113 implements MigrationInterface {
  name = "AddAmbiguousPaymentStatus1787459580113";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments_old') THEN
                    ALTER TABLE "payments_old" ALTER COLUMN "status" DROP DEFAULT;
                    ALTER TABLE "payments_old" ALTER COLUMN "status" TYPE character varying USING "status"::"text";
                END IF;
            END $$;
        `);
    await queryRunner.query(
      `ALTER TYPE "public"."payments_status_enum" RENAME TO "payments_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payments_status_enum" AS ENUM('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'REQUIRES_CAPTURE', 'PARTIALLY_CAPTURED', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE "public"."payments_status_enum" USING "status"::"text"::"public"."payments_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
    await queryRunner.query(`DROP TYPE "public"."payments_status_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."payments_status_enum_old" AS ENUM('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'REQUIRES_CAPTURE', 'PARTIALLY_CAPTURED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE "public"."payments_status_enum_old" USING "status"::"text"::"public"."payments_status_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
    await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."payments_status_enum_old" RENAME TO "payments_status_enum"`,
    );
    await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments_old') THEN
                    ALTER TABLE "payments_old" ALTER COLUMN "status" TYPE "public"."payments_status_enum" USING "status"::"public"."payments_status_enum";
                END IF;
            END $$;
        `);
  }
}
