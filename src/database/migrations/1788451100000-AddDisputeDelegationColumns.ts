import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Snapshotted from PaymentEntity.delegationId/initiatedBy at
 * DisputeService.recordDispute() time — see DisputeEntity.delegationId's
 * docblock. Backfills existing disputes from their payment's current
 * columns (itself just backfilled by AddPaymentDelegationColumns) — an
 * approximation for pre-existing rows, since the payment's delegation
 * columns could in principle have looked different at the historical
 * moment the dispute was actually created, but there is no other
 * surviving signal to snapshot from.
 */
export class AddDisputeDelegationColumns1788451100000 implements MigrationInterface {
  name = 'AddDisputeDelegationColumns1788451100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "disputes" ADD "delegation_id" uuid`);
    await queryRunner.query(`ALTER TABLE "disputes" ADD "initiated_by" character varying`);

    // disputes.payment_id is a plain varchar (no FK/uuid column type),
    // while payments.id is a real uuid column — needs an explicit cast to
    // compare them.
    await queryRunner.query(`
      UPDATE "disputes" d
      SET "delegation_id" = p."delegation_id",
          "initiated_by" = p."initiated_by"
      FROM "payments" p
      WHERE p."id" = d."payment_id"::uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "disputes" DROP COLUMN "initiated_by"`);
    await queryRunner.query(`ALTER TABLE "disputes" DROP COLUMN "delegation_id"`);
  }
}
