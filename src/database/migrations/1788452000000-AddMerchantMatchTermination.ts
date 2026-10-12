import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMerchantMatchTermination1788452000000 implements MigrationInterface {
  name = 'AddMerchantMatchTermination1788452000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" ADD "match_terminated_for_cause" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "match_reason_code" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "match_reason" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "match_terminated_by" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "match_terminated_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "match_reported_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "match_report_id" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "match_report_id"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "match_reported_at"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "match_terminated_at"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "match_terminated_by"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "match_reason"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "match_reason_code"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "match_terminated_for_cause"`);
  }
}
