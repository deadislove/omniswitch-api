import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `idempotency_key` was only ever unique globally (`(idempotency_key,
 * created_at)` — the `created_at` half is a Postgres requirement for a
 * unique constraint on a table partitioned by that column, not a
 * deliberate scoping choice, see CreatePartitionedPaymentsAndLedgerOutbox's
 * docblock). No merchant scoping at all: a caller who submits another
 * merchant's *known* idempotency key (leaked via a logging bug, a shared
 * support ticket, a compromised integration) would collide with it —
 * and, more immediately, IdempotencyInterceptor's Redis cache-replay path
 * (fixed in the same change as this migration) would return that other
 * merchant's cached charge response before the request ever reached
 * PaymentController's own ownership check. Stripe/Adyen both scope
 * idempotency keys per-account specifically to close this class of gap.
 *
 * Widens the constraint to `(merchant_id, idempotency_key, created_at)` —
 * still satisfies the partitioned-table requirement that `created_at` be
 * part of any unique constraint, now additionally scoped per merchant.
 */
export class ScopeIdempotencyKeyToMerchant1788065096858 implements MigrationInterface {
    name = 'ScopeIdempotencyKeyToMerchant1788065096858'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "UQ_payments_partitioned_idempotency_key"`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "UQ_payments_merchant_idempotency_key" UNIQUE ("merchant_id", "idempotency_key", "created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "UQ_payments_merchant_idempotency_key"`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "UQ_payments_partitioned_idempotency_key" UNIQUE ("idempotency_key", "created_at")`);
    }

}
