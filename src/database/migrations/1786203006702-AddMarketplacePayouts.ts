import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMarketplacePayouts1786203006702 implements MigrationInterface {
    name = 'AddMarketplacePayouts1786203006702'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "payouts" ("id" uuid NOT NULL, "merchant_id" character varying NOT NULL, "sweep_run_id" character varying NOT NULL, "gross_amount_minor_units" bigint NOT NULL, "reserve_amount_minor_units" bigint NOT NULL, "net_amount_minor_units" bigint NOT NULL, "currency_code" character varying(3) NOT NULL, "release_eligible_at" TIMESTAMP WITH TIME ZONE, "reserve_released" boolean NOT NULL DEFAULT false, "reserve_released_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_76855dc4f0a6c18c72eea302e87" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2d6776c4b15328f608f2cd47b0" ON "payouts" ("merchant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8f152f95d07c0862750cd68d8d" ON "payouts" ("merchant_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "payout_sweep_runs" ("id" uuid NOT NULL, "window_start" TIMESTAMP WITH TIME ZONE NOT NULL, "window_end" TIMESTAMP WITH TIME ZONE NOT NULL, "connected_merchants_paid" integer NOT NULL, "ran_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_d484de56a15f2cbb03a12d9b662" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "payout_reserve_bps" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "payout_reserve_hold_days" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "payout_reserve_hold_days"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "payout_reserve_bps"`);
        await queryRunner.query(`DROP TABLE "payout_sweep_runs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8f152f95d07c0862750cd68d8d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2d6776c4b15328f608f2cd47b0"`);
        await queryRunner.query(`DROP TABLE "payouts"`);
    }

}
