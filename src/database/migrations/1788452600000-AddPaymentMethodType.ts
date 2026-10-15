import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentMethodType1788452600000 implements MigrationInterface {
  name = 'AddPaymentMethodType1788452600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "payment_method_type" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "payment_method_type"`);
  }
}
