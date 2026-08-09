import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMarketplaceKycAndPayoutTransfers1786206958881 implements MigrationInterface {
    name = 'AddMarketplaceKycAndPayoutTransfers1786206958881'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payouts" ADD "kyc_blocked" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "payouts" ADD "kyc_cleared_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "payouts" ADD "transfer_status" character varying NOT NULL DEFAULT 'NOT_INITIATED'`);
        await queryRunner.query(`ALTER TABLE "payouts" ADD "transfer_id" character varying`);
        await queryRunner.query(`ALTER TABLE "payouts" ADD "transfer_initiated_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "payouts" ADD "transfer_error" character varying`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "kyc_status" character varying NOT NULL DEFAULT 'NOT_STARTED'`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "kyc_legal_name" character varying`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "kyc_tax_id" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyc_tax_id"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyc_legal_name"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyc_status"`);
        await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "transfer_error"`);
        await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "transfer_initiated_at"`);
        await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "transfer_id"`);
        await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "transfer_status"`);
        await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "kyc_cleared_at"`);
        await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN "kyc_blocked"`);
    }

}
