import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the new `PENDING_REVIEW` state in `MerchantEntity.kycStatus` —
 * `MerchantService.confirmKyc()` (the POST /webhooks/kyc receiver — see
 * PersonaKycProviderAdapter) looks a merchant up by this column on every
 * real-provider review decision; indexed for the same reason
 * `payouts.transfer_id` is (see `1788450000000-AddPayoutTransferIdIndex`).
 */
export class AddMerchantKycApplicationId1788450200000 implements MigrationInterface {
  name = 'AddMerchantKycApplicationId1788450200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" ADD "kyc_application_id" character varying`);
    await queryRunner.query(`CREATE INDEX "IDX_merchants_kyc_application_id" ON "merchants" ("kyc_application_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_merchants_kyc_application_id"`);
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "kyc_application_id"`);
  }
}
