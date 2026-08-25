import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantAmbiguousRiskFlag1787677053816 implements MigrationInterface {
    name = 'AddMerchantAmbiguousRiskFlag1787677053816'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "ambiguous_risk_flagged" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "ambiguous_risk_flagged_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "ambiguous_risk_flag_reason" character varying`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "ambiguous_risk_flagged_by" character varying`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "ambiguous_risk_auto_managed" boolean NOT NULL DEFAULT true`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "ambiguous_risk_auto_managed"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "ambiguous_risk_flagged_by"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "ambiguous_risk_flag_reason"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "ambiguous_risk_flagged_at"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "ambiguous_risk_flagged"`);
    }

}
