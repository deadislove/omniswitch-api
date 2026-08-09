import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSubscriptionCreditAndRetrySchedule1786204024267 implements MigrationInterface {
    name = 'AddSubscriptionCreditAndRetrySchedule1786204024267'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "subscriptions" ADD "pending_credit_minor_units" bigint`);
        await queryRunner.query(`ALTER TABLE "subscriptions" ADD "next_retry_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN "next_retry_at"`);
        await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN "pending_credit_minor_units"`);
    }

}
