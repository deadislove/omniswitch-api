import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The PENDING_APPROVAL hold state for an agent-initiated charge above
 * `SpendPolicy.requireApprovalAboveAmount` — see
 * ChargeApproval.aggregate.ts and ChargeApprovalService.
 */
export class CreateChargeApprovals1788450500000 implements MigrationInterface {
  name = 'CreateChargeApprovals1788450500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "charge_approvals" (
        "id" uuid NOT NULL,
        "payment_id" character varying NOT NULL,
        "delegation_id" character varying NOT NULL,
        "merchant_id" character varying NOT NULL,
        "amount_minor_units" bigint NOT NULL,
        "currency_code" character varying(3) NOT NULL,
        "idempotency_key" character varying NOT NULL,
        "charge_request" jsonb NOT NULL,
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "decided_by" character varying,
        "denial_reason" character varying,
        CONSTRAINT "PK_charge_approvals_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_charge_approvals_merchant_status" ON "charge_approvals" ("merchant_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_charge_approvals_delegation_id" ON "charge_approvals" ("delegation_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "charge_approvals"`);
  }
}
