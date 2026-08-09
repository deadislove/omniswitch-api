import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1786035884254 implements MigrationInterface {
    name = 'InitialSchema1786035884254'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."payments_status_enum" AS ENUM('PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'REQUIRES_CAPTURE', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED')`);
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL, "merchant_id" character varying NOT NULL, "customer_id" character varying, "order_id" character varying, "amount_minor_units" bigint NOT NULL, "currency_code" character varying(3) NOT NULL, "currency_minor_units" integer NOT NULL, "status" "public"."payments_status_enum" NOT NULL DEFAULT 'PENDING', "idempotency_key" character varying NOT NULL, "psp_provider" character varying, "psp_transaction_id" character varying, "psp_raw_response" jsonb, "risk_score" integer, "three_ds_result" jsonb, "refunds" jsonb NOT NULL DEFAULT '[]', "failure_reason" character varying, "failure_code" character varying, "description" character varying, "statement_descriptor" character varying, "payment_metadata" jsonb, "bin_info" jsonb, "fx_snapshot" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_59dcef70bd19850783c84f840e5" UNIQUE ("idempotency_key"), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c4a9a77d8ec9c37d3654a0d2eb" ON "payments" ("merchant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5f49aa1e2b60528ad62ec4f546" ON "payments" ("psp_transaction_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_32b41cdb985a296213e9a928b5" ON "payments" ("status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59dcef70bd19850783c84f840e" ON "payments" ("idempotency_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_d03e4fb12cd3383feecd8bab19" ON "payments" ("merchant_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "ledger_outbox" ("id" uuid NOT NULL, "payment_id" character varying NOT NULL, "event_type" character varying NOT NULL, "entries" jsonb NOT NULL, "status" character varying NOT NULL DEFAULT 'PENDING', "retry_count" integer NOT NULL DEFAULT '0', "last_error" character varying, "processed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d3e8d91ae06b9e921f031eff3ab" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_69c1e293be05c9ec8eaf4263d7" ON "ledger_outbox" ("payment_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d31602587568346ccf068304f" ON "ledger_outbox" ("status", "created_at") `);
        await queryRunner.query(`CREATE TABLE "merchants" ("id" uuid NOT NULL, "merchant_id" character varying NOT NULL, "name" character varying NOT NULL, "api_key_id" character varying NOT NULL, "api_key_secret_hash" character varying NOT NULL, "hmac_secret" character varying NOT NULL, "roles" jsonb NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4fd312ef25f8e05ad47bfe7ed25" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_829e43b4ae5e536cd560a83f0d" ON "merchants" ("merchant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f57dbae1efdae74dcb3b64756b" ON "merchants" ("api_key_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_f57dbae1efdae74dcb3b64756b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_829e43b4ae5e536cd560a83f0d"`);
        await queryRunner.query(`DROP TABLE "merchants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8d31602587568346ccf068304f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_69c1e293be05c9ec8eaf4263d7"`);
        await queryRunner.query(`DROP TABLE "ledger_outbox"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d03e4fb12cd3383feecd8bab19"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_59dcef70bd19850783c84f840e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_32b41cdb985a296213e9a928b5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5f49aa1e2b60528ad62ec4f546"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c4a9a77d8ec9c37d3654a0d2eb"`);
        await queryRunner.query(`DROP TABLE "payments"`);
        await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
    }

}
