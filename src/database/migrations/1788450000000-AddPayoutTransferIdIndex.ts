import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PayoutService.confirmTransfer() (the POST /webhooks/bank-transfer
 * receiver — see AchBankTransferAdapter/WireBankTransferAdapter) looks up
 * a Payout by transfer_id on every real-rail settlement callback; without
 * an index this is a full table scan on the payouts table's steady-state
 * hot path once BANK_TRANSFER_PROVIDER=ach/wire is in use.
 */
export class AddPayoutTransferIdIndex1788450000000 implements MigrationInterface {
  name = 'AddPayoutTransferIdIndex1788450000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_payouts_transfer_id" ON "payouts" ("transfer_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_payouts_transfer_id"`);
  }
}
