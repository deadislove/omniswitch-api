import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs `DisputeNotificationDispatcherService`'s per-merchant channel
 * selection (see docs/business-domain/disputes.md) — `dispute.created`/
 * `dispute.resolved` were already real emitted events; nothing
 * previously subscribed to them.
 */
export class AddMerchantDisputeNotificationChannel1788450100000 implements MigrationInterface {
  name = 'AddMerchantDisputeNotificationChannel1788450100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "dispute_notification_channel" character varying NOT NULL DEFAULT 'WEBHOOK'`,
    );
    await queryRunner.query(`ALTER TABLE "merchants" ADD "dispute_notification_target" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "dispute_notification_target"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "dispute_notification_channel"`);
  }
}
