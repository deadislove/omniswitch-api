import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs `PaymentAggregate.recordTaxRecord()` — a cross-border audit
 * record (not a tax calculation), populated at the same call sites and
 * under the same condition as `settlement_conversion` — see
 * `src/modules/payment/domain/services/tax-record.ts`'s docblock.
 */
export class AddPaymentTaxRecord1788450900000 implements MigrationInterface {
  name = 'AddPaymentTaxRecord1788450900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "tax_record" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "tax_record"`);
  }
}
