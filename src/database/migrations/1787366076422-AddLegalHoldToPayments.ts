import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Legal-hold flag (Phase 3 follow-up #5 — see docs/compliance/data-
 * retention.md, "What this doesn't cover" → "No legal-hold mechanism").
 *
 * A single boolean, not a full audit-trail table (who placed it, when,
 * why, when released) — deliberately. That kind of record-keeping is a
 * real compliance/legal-process concern, but it's outside this
 * project's PSP/payment-processing scope, and this project doesn't
 * model any other operator action that way either (e.g. a dispute's
 * `autoDecision` or a merchant's `isActive` toggle carry no audit trail
 * in this codebase). If a real deployment needs "who/when/why" for
 * legal holds specifically, that's an explicit, separate addition on
 * top of this flag, not something this migration tries to anticipate.
 *
 * Added to both `payments` (partitioned parent — `ADD COLUMN` on a
 * partitioned table propagates to every existing and future partition
 * automatically) and `archive.payments`, mirroring that schema's
 * existing column-parity design (see `CreateArchiveSchema`'s docblock).
 * In normal operation `archive.payments.legal_hold` should always be
 * `false`: placing a hold on an already-archived payment pulls it back
 * into the live `payments` table instead of flipping the flag in place
 * (see `LegalHoldService.placeHold()`) — a held record needs to be
 * trackable through the normal live-payment query path, not sitting in
 * cold storage. The column still exists on `archive.payments` for
 * schema-parity and as a defense-in-depth check in the deletion job.
 */
export class AddLegalHoldToPayments1787366076422 implements MigrationInterface {
    name = 'AddLegalHoldToPayments1787366076422'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" ADD COLUMN "legal_hold" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "archive"."payments" ADD COLUMN "legal_hold" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "archive"."payments" DROP COLUMN "legal_hold"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "legal_hold"`);
    }

}
