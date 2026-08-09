import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantMfa1786155669507 implements MigrationInterface {
    name = 'AddMerchantMfa1786155669507'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" ADD "mfa_secret_ciphertext" character varying`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "mfa_enabled" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "mfa_backup_code_hashes" jsonb NOT NULL DEFAULT '[]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "mfa_backup_code_hashes"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "mfa_enabled"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "mfa_secret_ciphertext"`);
    }

}
