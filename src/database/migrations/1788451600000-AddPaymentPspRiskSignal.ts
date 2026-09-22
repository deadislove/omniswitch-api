import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentPspRiskSignal1788451600000 implements MigrationInterface {
  name = 'AddPaymentPspRiskSignal1788451600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "psp_risk_signal" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "psp_risk_signal"`);
  }
}
