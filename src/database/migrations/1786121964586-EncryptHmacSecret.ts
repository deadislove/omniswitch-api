import { MigrationInterface, QueryRunner } from "typeorm";

export class EncryptHmacSecret1786121964586 implements MigrationInterface {
    name = 'EncryptHmacSecret1786121964586'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" RENAME COLUMN "hmac_secret" TO "hmac_secret_ciphertext"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" RENAME COLUMN "hmac_secret_ciphertext" TO "hmac_secret"`);
    }

}
