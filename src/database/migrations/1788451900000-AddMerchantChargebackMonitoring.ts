import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMerchantChargebackMonitoring1788451900000 implements MigrationInterface {
  name = 'AddMerchantChargebackMonitoring1788451900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "chargeback_monitoring_tier" character varying NOT NULL DEFAULT 'NONE'`,
    );
    await queryRunner.query(`ALTER TABLE "merchants" ADD "chargeback_monitoring_flagged_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "chargeback_monitoring_reason" character varying`);
    await queryRunner.query(`ALTER TABLE "merchants" ADD "chargeback_monitoring_flagged_by" character varying`);
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "chargeback_monitoring_auto_managed" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "chargeback_monitoring_notification_channel" character varying NOT NULL DEFAULT 'WEBHOOK'`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "chargeback_monitoring_notification_target" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "chargeback_monitoring_notification_target"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "chargeback_monitoring_notification_channel"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "chargeback_monitoring_auto_managed"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "chargeback_monitoring_flagged_by"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "chargeback_monitoring_reason"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "chargeback_monitoring_flagged_at"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "chargeback_monitoring_tier"`);
  }
}
