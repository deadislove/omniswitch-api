import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPaymentSplits1786199535856 implements MigrationInterface {
    name = 'AddPaymentSplits1786199535856'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" ADD "splits" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "splits"`);
    }

}
