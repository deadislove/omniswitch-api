import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantFeeTiers1786245951739 implements MigrationInterface {
    name = 'AddMerchantFeeTiers1786245951739'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "fee_tiers" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "fee_tiers"`);
    }

}
