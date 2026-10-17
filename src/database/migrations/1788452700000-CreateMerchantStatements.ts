import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMerchantStatements1788452700000 implements MigrationInterface {
  name = 'CreateMerchantStatements1788452700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchant_statements" (
        "id" uuid NOT NULL,
        "merchant_id" character varying NOT NULL,
        "period_start" TIMESTAMP WITH TIME ZONE NOT NULL,
        "period_end" TIMESTAMP WITH TIME ZONE NOT NULL,
        "breakdowns" jsonb NOT NULL,
        "generated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_merchant_statements_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_merchant_statements_merchant_period" ON "merchant_statements" ("merchant_id", "period_start", "period_end")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_merchant_statements_merchant_period"`);
    await queryRunner.query(`DROP TABLE "merchant_statements"`);
  }
}
