import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentScaExemption1788452200000 implements MigrationInterface {
  name = 'AddPaymentScaExemption1788452200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "sca_exemption_requested" character varying`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "sca_exemption_reason" character varying`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "sca_exemption_indicator" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "sca_exemption_indicator"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "sca_exemption_reason"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "sca_exemption_requested"`);
  }
}
