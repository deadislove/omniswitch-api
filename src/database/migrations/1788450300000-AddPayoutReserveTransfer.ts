import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the reserve follow-up transfer — see
 * Payout.recordReserveTransferPending()/recordReserveTransferInitiated()
 * and PayoutService.initiateReserveTransfer(). A second, independent
 * transfer-status quad from the existing netAmount one (transfer_status/
 * transfer_id/transfer_initiated_at/transfer_error) — a reserve released
 * before, during, or long after the netAmount transfer needs its own
 * transfer, not a merge into whatever already happened to netAmount (see
 * docs/business-domain/marketplace-and-payouts.md).
 */
export class AddPayoutReserveTransfer1788450300000 implements MigrationInterface {
  name = 'AddPayoutReserveTransfer1788450300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD "reserve_transfer_status" character varying NOT NULL DEFAULT 'NOT_INITIATED'`,
    );
    await queryRunner.query(`ALTER TABLE "payouts" ADD "reserve_transfer_id" character varying`);
    await queryRunner.query(`ALTER TABLE "payouts" ADD "reserve_transfer_initiated_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "payouts" ADD "reserve_transfer_error" character varying`);
    await queryRunner.query(`CREATE INDEX "IDX_payouts_reserve_transfer_id" ON "payouts" ("reserve_transfer_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_payouts_reserve_transfer_id"`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "reserve_transfer_error"`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "reserve_transfer_initiated_at"`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "reserve_transfer_id"`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "reserve_transfer_status"`);
  }
}
