import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit-only snapshot of the charging merchant's risk tier at the moment
 * DisputeService.recordDispute() called decideAutoDisposition() — see
 * DisputeEntity.merchantRiskTierAtDecision's docblock. No backfill for
 * existing rows: RiskTieringService has never persisted a historical tier
 * value (only the derived reserveBps/reserveHoldDays), so there is no
 * surviving signal to reconstruct what tier was actually in effect for a
 * dispute recorded before this column existed — those rows get NULL,
 * which correctly reads as "not tracked at the time," not "MEDIUM."
 */
export class AddDisputeMerchantRiskTierAtDecision1788451400000 implements MigrationInterface {
  name = 'AddDisputeMerchantRiskTierAtDecision1788451400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "disputes" ADD "merchant_risk_tier_at_decision" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "disputes" DROP COLUMN "merchant_risk_tier_at_decision"`);
  }
}
