import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSubscriptionLastDeclineCode1786207898538 implements MigrationInterface {
    name = 'AddSubscriptionLastDeclineCode1786207898538'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "subscriptions" ADD "last_decline_code" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN "last_decline_code"`);
    }

}
