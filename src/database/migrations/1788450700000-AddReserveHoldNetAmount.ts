import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs RiskTieringService's tier-escalation reserve top-up (Phase 1,
 * item 3) — ReserveService.topUpHeldReservesForMerchant() needs each
 * hold's original net amount to recompute the target reserve at a new
 * bps; the reserve slice alone (amount_minor_units) doesn't carry enough
 * information to derive it back.
 *
 * Backfilled from the reserve amount itself for any pre-existing rows —
 * an approximation (assumes the *current* merchant reserveBps applied
 * when each old hold was created, which may not be true for a merchant
 * whose rate has changed since), acceptable only because a backfilled
 * row's netAmount is exclusively used to compute a top-up *delta*, and
 * getting that approximate for a handful of pre-migration holds is a far
 * smaller risk than leaving the column NULL and crashing the top-up sweep
 * outright the first time it touches one.
 */
export class AddReserveHoldNetAmount1788450700000 implements MigrationInterface {
  name = 'AddReserveHoldNetAmount1788450700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reserve_holds" ADD "net_amount_minor_units" bigint`);
    await queryRunner.query(`UPDATE "reserve_holds" SET "net_amount_minor_units" = "amount_minor_units"`);
    await queryRunner.query(`ALTER TABLE "reserve_holds" ALTER COLUMN "net_amount_minor_units" SET NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reserve_holds" DROP COLUMN "net_amount_minor_units"`);
  }
}
