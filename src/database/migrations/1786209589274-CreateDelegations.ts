import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDelegations1786209589274 implements MigrationInterface {
    name = 'CreateDelegations1786209589274'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "delegations" ("id" uuid NOT NULL, "merchant_id" character varying NOT NULL, "agent_name" character varying NOT NULL, "per_transaction_limit_minor_units" bigint NOT NULL, "monthly_limit_minor_units" bigint NOT NULL, "currency_code" character varying(3) NOT NULL, "allowed_categories" text, "status" character varying NOT NULL DEFAULT 'ACTIVE', "current_month_key" character varying NOT NULL, "current_month_spent_minor_units" bigint NOT NULL DEFAULT '0', "jti" character varying NOT NULL, "token_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_22aa88239c24947d7cf5a84a607" UNIQUE ("jti"), CONSTRAINT "PK_01f9fbbc9b3bf52236a4e951b19" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7f2e8d5f0368dc0c8929201ebc" ON "delegations" ("merchant_id", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_7f2e8d5f0368dc0c8929201ebc"`);
        await queryRunner.query(`DROP TABLE "delegations"`);
    }

}
