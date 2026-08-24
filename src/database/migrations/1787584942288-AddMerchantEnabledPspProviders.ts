import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantEnabledPspProviders1787584942288 implements MigrationInterface {
    name = 'AddMerchantEnabledPspProviders1787584942288'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "enabled_psp_providers" jsonb NOT NULL DEFAULT '["STRIPE","ADYEN"]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "enabled_psp_providers"`);
    }

}
