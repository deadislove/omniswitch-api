import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs `SpendPolicy.requireApprovalAboveAmount` — see
 * docs/business-domain/future-directions.md#agentic-payments and
 * ChargeApprovalService. Null means no approval gate (every existing
 * delegation's behavior is unchanged): every charge within the existing
 * per-transaction/monthly limits still auto-executes exactly as before.
 */
export class AddDelegationRequireApprovalAboveAmount1788450400000 implements MigrationInterface {
  name = 'AddDelegationRequireApprovalAboveAmount1788450400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegations" ADD "require_approval_above_amount_minor_units" bigint`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegations" DROP COLUMN "require_approval_above_amount_minor_units"`);
  }
}
