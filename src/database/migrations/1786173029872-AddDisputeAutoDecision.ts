import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDisputeAutoDecision1786173029872 implements MigrationInterface {
    name = 'AddDisputeAutoDecision1786173029872'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "disputes" ADD "auto_decision" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "disputes" DROP COLUMN "auto_decision"`);
    }

}
