import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMerchantAmlReviewFlag1788451300000 implements MigrationInterface {
  name = 'AddMerchantAmlReviewFlag1788451300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" ADD "aml_review_flagged" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "aml_review_flagged_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "aml_review_flag_reason" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "aml_review_flagged_by" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "aml_review_auto_managed" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "aml_review_notification_channel" character varying NOT NULL DEFAULT 'WEBHOOK'`,
    );
    await queryRunner.query(`ALTER TABLE "merchants" ADD "aml_review_notification_target" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "aml_review_notification_target"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "aml_review_notification_channel"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "aml_review_auto_managed"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "aml_review_flagged_by"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "aml_review_flag_reason"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "aml_review_flagged_at"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "aml_review_flagged"`);
  }
}
