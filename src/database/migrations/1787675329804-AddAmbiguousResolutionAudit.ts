import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAmbiguousResolutionAudit1787675329804 implements MigrationInterface {
    name = 'AddAmbiguousResolutionAudit1787675329804'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" ADD "ambiguous_resolved_by" character varying`);
        await queryRunner.query(`ALTER TABLE "payments" ADD "ambiguous_resolved_reason" character varying`);
        await queryRunner.query(`ALTER TABLE "payments" ADD "ambiguous_resolved_at" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "ambiguous_resolved_at"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "ambiguous_resolved_reason"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "ambiguous_resolved_by"`);
    }

}
