import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlansAndSubscriptionPlanId1786177009690 implements MigrationInterface {
    name = 'AddPlansAndSubscriptionPlanId1786177009690'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "plans" ("id" uuid NOT NULL, "merchant_id" character varying NOT NULL, "name" character varying NOT NULL, "amount_minor_units" bigint NOT NULL, "currency_code" character varying(3) NOT NULL, "interval" character varying NOT NULL, "interval_count" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3720521a81c7c24fe9b7202ba61" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5cca6798481477b70a1a87e698" ON "plans" ("merchant_id", "is_active") `);
        await queryRunner.query(`ALTER TABLE "subscriptions" ADD "plan_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN "plan_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5cca6798481477b70a1a87e698"`);
        await queryRunner.query(`DROP TABLE "plans"`);
    }

}
