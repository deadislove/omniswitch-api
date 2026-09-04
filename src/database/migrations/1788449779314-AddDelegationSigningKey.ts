import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `signing_key_ciphertext` to `delegations` — see
 * DelegationEntity's own column comment for what it's for
 * (HmacSignatureGuard's per-agent request signing).
 *
 * Hand-written, not `migration:generate`-produced: this dev database has
 * accumulated unrelated schema drift from other local experimentation
 * (partitioning-cutover index/constraint naming, an unrelated dropped
 * column) that a blind `migration:generate` run picked up alongside the
 * one real change — see database-migrations.md's own workflow section
 * for why `migration:generate` diffs against whatever this machine's DB
 * currently looks like, not a guaranteed-clean reference schema. Nullable
 * add, no backfill needed — see database-migrations.md's expand/contract
 * policy; this is a pure expand step.
 */
export class AddDelegationSigningKey1788449779314 implements MigrationInterface {
  name = 'AddDelegationSigningKey1788449779314';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegations" ADD "signing_key_ciphertext" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegations" DROP COLUMN "signing_key_ciphertext"`);
  }
}
