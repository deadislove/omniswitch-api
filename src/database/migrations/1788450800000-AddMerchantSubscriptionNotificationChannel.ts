import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs `SubscriptionNotificationDispatcherService`'s per-merchant
 * channel selection — same shape as
 * `AddMerchantDisputeNotificationChannel1788450100000`, but independent
 * columns: `subscription.past_due`/`subscription.canceled` were already
 * real emitted events (see `SubscriptionService`); nothing previously
 * subscribed to them.
 */
export class AddMerchantSubscriptionNotificationChannel1788450800000 implements MigrationInterface {
  name = 'AddMerchantSubscriptionNotificationChannel1788450800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "subscription_notification_channel" character varying NOT NULL DEFAULT 'WEBHOOK'`,
    );
    await queryRunner.query(`ALTER TABLE "merchants" ADD "subscription_notification_target" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "subscription_notification_target"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "subscription_notification_channel"`);
  }
}
