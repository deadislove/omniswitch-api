import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantMarketplaceAccountType1786194418648 implements MigrationInterface {
    name = 'AddMerchantMarketplaceAccountType1786194418648'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "account_type" character varying NOT NULL DEFAULT 'PLATFORM'`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "platform_merchant_id" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "platform_merchant_id"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "account_type"`);
    }

}
