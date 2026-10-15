import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBnplOrders1788452500000 implements MigrationInterface {
  name = 'CreateBnplOrders1788452500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "bnpl_orders" (
        "id" uuid NOT NULL,
        "merchant_id" character varying NOT NULL,
        "amount_minor_units" bigint NOT NULL,
        "currency_code" character varying(3) NOT NULL,
        "idempotency_key" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'PENDING_AUTHORIZATION',
        "customer_id" character varying,
        "description" character varying,
        "provider_order_id" character varying,
        "provider_capture_id" character varying,
        "failure_reason" character varying,
        "refunds" jsonb NOT NULL DEFAULT '[]',
        "captured_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bnpl_orders_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_bnpl_orders_merchant_id" ON "bnpl_orders" ("merchant_id")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_bnpl_orders_merchant_id_created_at" ON "bnpl_orders" ("merchant_id", "created_at")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_bnpl_orders_provider_order_id" ON "bnpl_orders" ("provider_order_id")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_bnpl_orders_idempotency_key" ON "bnpl_orders" ("idempotency_key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_bnpl_orders_idempotency_key"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bnpl_orders_provider_order_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bnpl_orders_merchant_id_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bnpl_orders_merchant_id"`);
    await queryRunner.query(`DROP TABLE "bnpl_orders"`);
  }
}
