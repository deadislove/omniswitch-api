import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMerchantTaxForms1099K1788452900000 implements MigrationInterface {
  name = 'CreateMerchantTaxForms1099K1788452900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchant_tax_forms_1099k" (
        "id" uuid NOT NULL,
        "merchant_id" character varying NOT NULL,
        "tax_year" integer NOT NULL,
        "currency_code" character varying(3) NOT NULL,
        "gross_amount_minor_units" bigint NOT NULL,
        "transaction_count" integer NOT NULL,
        "monthly_amounts_minor_units" jsonb NOT NULL,
        "threshold_applied_minor_units" bigint NOT NULL,
        "reportable" boolean NOT NULL,
        "generated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_merchant_tax_forms_1099k_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_merchant_tax_forms_1099k_merchant_year" ON "merchant_tax_forms_1099k" ("merchant_id", "tax_year")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_merchant_tax_forms_1099k_merchant_year"`);
    await queryRunner.query(`DROP TABLE "merchant_tax_forms_1099k"`);
  }
}
