import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs classifyDeclineCode()'s per-PSP HARD_DECLINE_CODES tables (Phase
 * 1) — `last_decline_code` alone is no longer enough to re-classify a
 * subscription's most recent decline later (canceledByHardDecline), since
 * the same raw code string means different things under Stripe's vs
 * Adyen's vocabulary. See subscription.aggregate.ts's classifyDeclineCode()
 * docblock.
 */
export class AddSubscriptionLastDeclinePspProvider1788451200000 implements MigrationInterface {
  name = 'AddSubscriptionLastDeclinePspProvider1788451200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "subscriptions" ADD "last_decline_psp_provider" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN "last_decline_psp_provider"`);
  }
}
