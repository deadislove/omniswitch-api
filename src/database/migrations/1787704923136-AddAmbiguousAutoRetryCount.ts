import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAmbiguousAutoRetryCount1787704923136 implements MigrationInterface {
    name = 'AddAmbiguousAutoRetryCount1787704923136'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" ADD "ambiguous_auto_retry_count" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "ambiguous_auto_retry_count"`);
    }

}
