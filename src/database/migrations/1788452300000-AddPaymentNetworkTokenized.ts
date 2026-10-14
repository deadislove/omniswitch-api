import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentNetworkTokenized1788452300000 implements MigrationInterface {
  name = 'AddPaymentNetworkTokenized1788452300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "network_tokenized" boolean`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "network_tokenized"`);
  }
}
