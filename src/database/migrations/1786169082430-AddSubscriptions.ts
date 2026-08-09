import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSubscriptions1786169082430 implements MigrationInterface {
    name = 'AddSubscriptions1786169082430'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "subscriptions" ("id" uuid NOT NULL, "merchant_id" character varying NOT NULL, "customer_id" character varying NOT NULL, "amount_minor_units" bigint NOT NULL, "currency_code" character varying(3) NOT NULL, "interval" character varying NOT NULL, "interval_count" integer NOT NULL, "payment_method_id" character varying NOT NULL, "status" character varying NOT NULL, "current_period_start" TIMESTAMP WITH TIME ZONE NOT NULL, "current_period_end" TIMESTAMP WITH TIME ZONE NOT NULL, "cancel_at_period_end" boolean NOT NULL DEFAULT false, "failed_attempts" integer NOT NULL DEFAULT '0', "order_id" character varying, "description" character varying, "canceled_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a87248d73155605cf782be9ee5e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_253dc9ba77867f8808fa037bbf" ON "subscriptions" ("merchant_id", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_253dc9ba77867f8808fa037bbf"`);
        await queryRunner.query(`DROP TABLE "subscriptions"`);
    }

}
