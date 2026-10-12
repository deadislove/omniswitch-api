import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentInterchangeQualification1788452100000 implements MigrationInterface {
  name = 'AddPaymentInterchangeQualification1788452100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "avs_result" character varying`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "cvv_result" character varying`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "interchange_qualification" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "interchange_qualification"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "cvv_result"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "avs_result"`);
  }
}
