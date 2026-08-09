import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDisputes1786128008287 implements MigrationInterface {
    name = 'AddDisputes1786128008287'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "disputes" ("id" uuid NOT NULL, "payment_id" character varying NOT NULL, "merchant_id" character varying NOT NULL, "psp_provider" character varying NOT NULL, "psp_dispute_id" character varying NOT NULL, "amount_minor_units" bigint NOT NULL, "currency_code" character varying(3) NOT NULL, "reason" character varying, "status" character varying NOT NULL DEFAULT 'NEEDS_RESPONSE', "respond_by" TIMESTAMP WITH TIME ZONE NOT NULL, "evidence" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3c97580d01c1a4b0b345c42a107" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8f43030d85eeeee75293695d9c" ON "disputes" ("payment_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5c024876ccb4a65ed6faa8ebf0" ON "disputes" ("psp_dispute_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d24a198c661c5f841d593b4eec" ON "disputes" ("merchant_id", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_d24a198c661c5f841d593b4eec"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5c024876ccb4a65ed6faa8ebf0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8f43030d85eeeee75293695d9c"`);
        await queryRunner.query(`DROP TABLE "disputes"`);
    }

}
