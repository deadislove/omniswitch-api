import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMerchantKyb1788451700000 implements MigrationInterface {
  name = 'AddMerchantKyb1788451700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "kyb_status" character varying NOT NULL DEFAULT 'NOT_STARTED'`,
    );
    await queryRunner.query(`ALTER TABLE "merchants" ADD "kyb_legal_name" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "kyb_tax_id" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "kyb_country" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "kyb_beneficial_owners" jsonb`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "kyb_application_id" character varying`);
    await queryRunner.query(`CREATE INDEX "IDX_merchants_kyb_application_id" ON "merchants" ("kyb_application_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_merchants_kyb_application_id"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyb_application_id"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyb_beneficial_owners"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyb_country"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyb_tax_id"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyb_legal_name"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyb_status"`);
  }
}
