import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Promotes `delegationId`/`initiatedBy` from the old `payment_metadata`
 * jsonb bag (which had no query surface of its own) to real, indexed
 * columns — see PaymentEntity.delegationId's docblock. Backfills from
 * the existing jsonb for any payment that already had it set, rather
 * than leaving pre-existing agent-initiated charges looking
 * human-initiated.
 */
export class AddPaymentDelegationColumns1788451000000 implements MigrationInterface {
  name = 'AddPaymentDelegationColumns1788451000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "delegation_id" uuid`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "initiated_by" character varying NOT NULL DEFAULT 'human'`);
    await queryRunner.query(`CREATE INDEX "IDX_payments_delegation_id" ON "payments" ("delegation_id")`);

    await queryRunner.query(`
      UPDATE "payments"
      SET "delegation_id" = ("payment_metadata"->>'delegationId')::uuid,
          "initiated_by" = 'agent'
      WHERE "payment_metadata"->>'initiatedBy' = 'agent'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_payments_delegation_id"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "initiated_by"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "delegation_id"`);
  }
}
