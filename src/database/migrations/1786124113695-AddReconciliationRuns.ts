import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReconciliationRuns1786124113695 implements MigrationInterface {
    name = 'AddReconciliationRuns1786124113695'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "reconciliation_runs" ("id" uuid NOT NULL, "psp_provider" character varying NOT NULL, "window_start" TIMESTAMP WITH TIME ZONE NOT NULL, "window_end" TIMESTAMP WITH TIME ZONE NOT NULL, "transactions_checked" integer NOT NULL, "mismatches" jsonb NOT NULL DEFAULT '[]', "status" character varying NOT NULL, "ran_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_4edbdb165c9e754997036a4176a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1172b295209a7d4e2200faacc3" ON "reconciliation_runs" ("psp_provider", "ran_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_1172b295209a7d4e2200faacc3"`);
        await queryRunner.query(`DROP TABLE "reconciliation_runs"`);
    }

}
