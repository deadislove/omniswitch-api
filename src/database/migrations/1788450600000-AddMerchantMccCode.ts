import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs RiskTieringService's multi-factor tiering (Phase 1, item 1) —
 * mccCode is operator-set (PATCH .../mcc-code); industryRiskCategory is
 * derived from it at write time via mcc-risk-lookup.ts, not looked up
 * fresh on every evaluation (see MerchantEntity's docblock).
 */
export class AddMerchantMccCode1788450600000 implements MigrationInterface {
  name = 'AddMerchantMccCode1788450600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" ADD "mcc_code" character varying`);
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "industry_risk_category" character varying NOT NULL DEFAULT 'UNKNOWN'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "industry_risk_category"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "mcc_code"`);
  }
}
