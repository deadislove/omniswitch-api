import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantRiskTierAutoManaged1786170012464 implements MigrationInterface {
    name = 'AddMerchantRiskTierAutoManaged1786170012464'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "risk_tier_auto_managed" boolean NOT NULL DEFAULT true`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "risk_tier_auto_managed"`);
    }

}
