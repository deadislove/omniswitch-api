import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantFeeRate1786126993596 implements MigrationInterface {
    name = 'AddMerchantFeeRate1786126993596'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "platform_fee_bps" integer NOT NULL DEFAULT '150'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "platform_fee_bps"`);
    }

}
