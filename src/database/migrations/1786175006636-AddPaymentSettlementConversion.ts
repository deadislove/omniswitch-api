import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPaymentSettlementConversion1786175006636 implements MigrationInterface {
    name = 'AddPaymentSettlementConversion1786175006636'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" ADD "settlement_conversion" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "settlement_conversion"`);
    }

}
