import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInstantPayoutRail1788452400000 implements MigrationInterface {
  name = 'AddInstantPayoutRail1788452400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payouts" ADD "transfer_rail" character varying`);
    await queryRunner.query(`ALTER TABLE "payouts" ADD "instant_fee_amount_minor_units" bigint`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "payout_rail" character varying NOT NULL DEFAULT 'STANDARD'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "payout_rail"`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "instant_fee_amount_minor_units"`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "transfer_rail"`);
  }
}
