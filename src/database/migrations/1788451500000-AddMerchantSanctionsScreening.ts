import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMerchantSanctionsScreening1788451500000 implements MigrationInterface {
  name = 'AddMerchantSanctionsScreening1788451500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" ADD "legal_name" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "tax_id" character varying`);
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "sanctions_screening_status" character varying NOT NULL DEFAULT 'NOT_SCREENED'`,
    );
    await queryRunner.query(`ALTER TABLE "merchants" ADD "sanctions_screening_confidence" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "sanctions_screened_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "sanctions_match_details" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "sanctions_reviewed_by" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "sanctions_reviewed_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "sanctions_review_resolution" character varying`);
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "sanctions_notification_channel" character varying NOT NULL DEFAULT 'WEBHOOK'`,
    );
    await queryRunner.query(`ALTER TABLE "merchants" ADD "sanctions_notification_target" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_notification_target"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_notification_channel"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_review_resolution"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_reviewed_at"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_reviewed_by"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_match_details"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_screened_at"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_screening_confidence"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "sanctions_screening_status"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "tax_id"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "legal_name"`);
  }
}
