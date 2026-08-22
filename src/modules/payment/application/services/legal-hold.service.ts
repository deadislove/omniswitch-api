import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface LegalHoldResult {
  id: string;
  legalHold: boolean;
  location: 'live' | 'restored-from-archive';
}

/**
 * Legal Hold Service (Phase 3 follow-up #5 — see
 * docs/compliance/data-retention.md, "No legal-hold mechanism").
 *
 * Operates on `payments`/`archive.payments` directly via raw SQL
 * through the injected `DataSource`, not through `PaymentRepositoryPort`/
 * `PaymentAggregate` — same reasoning as the archiving/deletion jobs:
 * this is a data-retention/ops concern layered on top of the payment
 * schema, not a payment-lifecycle business rule the domain aggregate
 * needs to know about. Keeping it out of `PaymentAggregate` avoids
 * touching every construction site of that aggregate for a field with
 * no bearing on payment processing itself.
 *
 * Deliberately no audit trail (who placed it, when, why) — see the
 * migration's own docblock (`1787366076422-AddLegalHoldToPayments.ts`)
 * for why that's out of scope here.
 */
@Injectable()
export class LegalHoldService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Places a hold on a payment, wherever it currently lives. A payment
   * already archived is pulled back into the live `payments` table as
   * part of placing the hold — a record under active legal/regulatory
   * scrutiny needs to be reachable through the normal payment query
   * path (GET /payments/:id, admin lookups, etc.), not left in cold
   * storage. This also means a held payment simply becomes
   * archive-eligible again, through the normal archiving job, the next
   * time it runs after the hold is released — no separate "re-archive"
   * step needed.
   *
   * Returns `location: 'live'` if the payment was already in the live
   * table (hold placed in place), or `'restored-from-archive'` if it
   * had to be pulled out of cold storage first — the caller (the admin
   * HTTP endpoint) surfaces this so an operator knows whether this
   * action just moved a record. Throws `NotFoundException` if the id
   * doesn't exist in either table.
   */
  async placeHold(paymentId: string): Promise<LegalHoldResult> {
    const [liveRow] = await this.dataSource.query(`SELECT "id" FROM "payments" WHERE "id" = $1`, [paymentId]);
    if (liveRow) {
      await this.dataSource.query(`UPDATE "payments" SET "legal_hold" = true WHERE "id" = $1`, [paymentId]);
      return { id: paymentId, legalHold: true, location: 'live' };
    }

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [archivedRow] = await runner.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [paymentId]);
      if (!archivedRow) {
        throw new NotFoundException({ statusCode: 404, error: `Payment ${paymentId} not found`, code: 'PAYMENT_NOT_FOUND' });
      }

      // "status" needs an explicit cast: archive.payments.status is a
      // plain varchar (CreateArchiveSchema.ts), but the live payments
      // table's status column is the real "payments_status_enum" type
      // (Stage 1 partitioning reused it directly, see that migration's
      // docblock). Postgres has no implicit varchar-to-enum cast, so an
      // INSERT...SELECT copying this column across the two tables
      // requires the cast below — without it, Postgres rejects the
      // insert as a type mismatch.
      await runner.query(
        `INSERT INTO "payments" (
           "id", "merchant_id", "customer_id", "order_id", "amount_minor_units",
           "currency_code", "currency_minor_units", "status", "idempotency_key",
           "psp_provider", "psp_transaction_id", "psp_raw_response", "risk_score",
           "three_ds_result", "refunds", "captures", "failure_reason", "failure_code",
           "description", "statement_descriptor", "payment_metadata", "bin_info",
           "fx_snapshot", "settlement_conversion", "splits", "created_at", "updated_at",
           "legal_hold"
         )
         SELECT
           "id", "merchant_id", "customer_id", "order_id", "amount_minor_units",
           "currency_code", "currency_minor_units", "status"::"payments_status_enum", "idempotency_key",
           "psp_provider", "psp_transaction_id", "psp_raw_response", "risk_score",
           "three_ds_result", "refunds", "captures", "failure_reason", "failure_code",
           "description", "statement_descriptor", "payment_metadata", "bin_info",
           "fx_snapshot", "settlement_conversion", "splits", "created_at", "updated_at",
           true
         FROM "archive"."payments" WHERE "id" = $1`,
        [paymentId],
      );
      await runner.query(`DELETE FROM "archive"."payments" WHERE "id" = $1`, [paymentId]);

      await runner.commitTransaction();
      return { id: paymentId, legalHold: true, location: 'restored-from-archive' };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  /**
   * Releases a hold. Only ever operates on the live `payments` table —
   * a held payment is always live (placeHold() guarantees that), so a
   * release request for an id not currently live means either the id
   * doesn't exist or it was never held in the first place.
   *
   * Returns `location: 'live'` unconditionally (the only outcome this
   * method can produce). Throws `NotFoundException` if the id isn't
   * currently in the live table.
   */
  async releaseHold(paymentId: string): Promise<LegalHoldResult> {
    const [row] = await this.dataSource.query(`SELECT "id" FROM "payments" WHERE "id" = $1`, [paymentId]);
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Payment ${paymentId} not found among live payments (a payment must be live to have its legal hold released)`,
        code: 'PAYMENT_NOT_FOUND',
      });
    }
    await this.dataSource.query(`UPDATE "payments" SET "legal_hold" = false WHERE "id" = $1`, [paymentId]);
    return { id: paymentId, legalHold: false, location: 'live' };
  }
}
