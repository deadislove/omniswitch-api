import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMerchantCountry1788452800000 implements MigrationInterface {
  name = 'AddMerchantCountry1788452800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" ADD "country" character varying(2)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "merchants" DROP COLUMN "country"`);
  }
}
