import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantSettlementCurrency1786158174052 implements MigrationInterface {
    name = 'AddMerchantSettlementCurrency1786158174052'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "settlement_currency" character varying(3)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "settlement_currency"`);
    }

}
