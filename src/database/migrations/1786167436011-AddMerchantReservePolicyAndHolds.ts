import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMerchantReservePolicyAndHolds1786167436011 implements MigrationInterface {
    name = 'AddMerchantReservePolicyAndHolds1786167436011'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "reserve_holds" ("id" uuid NOT NULL, "payment_id" character varying NOT NULL, "merchant_id" character varying NOT NULL, "amount_minor_units" bigint NOT NULL, "currency_code" character varying(3) NOT NULL, "status" character varying NOT NULL DEFAULT 'HELD', "release_eligible_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "released_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_a836f7f88a15b289b2c9fd7d00f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a36da295ae0c69bcd67c170b83" ON "reserve_holds" ("payment_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_04b16dafe46e7af3727536a9aa" ON "reserve_holds" ("merchant_id", "status") `);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "reserve_bps" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "merchants" ADD "reserve_hold_days" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "reserve_hold_days"`);
        await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "reserve_bps"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_04b16dafe46e7af3727536a9aa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a36da295ae0c69bcd67c170b83"`);
        await queryRunner.query(`DROP TABLE "reserve_holds"`);
    }

}
