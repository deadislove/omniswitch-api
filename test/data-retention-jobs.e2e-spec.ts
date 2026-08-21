import { randomUUID } from 'crypto';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { AppDataSource } from '../src/database/data-source';
import { archivePayments, archiveLedgerOutbox } from '../src/jobs/run-archiving-job';
import { runDeletion } from '../src/jobs/run-deletion-job';

/**
 * Exercises the archiving (10a-10c) and deletion (Option 3's second
 * tier) jobs directly against the real e2e database — not through HTTP,
 * since these jobs are standalone scripts outside the app's request
 * path (see run-archiving-job.ts's docblock for why). Seeds rows with
 * controlled `created_at`/status/dispute state via raw SQL, the same
 * way the jobs themselves query — this is deliberately a test of the
 * job logic against real Postgres semantics (interval arithmetic, jsonb
 * containment), not a mock of it.
 */
describe('Data retention jobs — archiving and deletion (e2e)', () => {
  const backupPath = `/tmp/omniswitch-retention-test-${randomUUID()}`;
  const seededPaymentIds: string[] = [];
  const seededOutboxIds: string[] = [];

  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (seededPaymentIds.length > 0) {
      await AppDataSource.query(`DELETE FROM "payments" WHERE "id" = ANY($1)`, [seededPaymentIds]);
      await AppDataSource.query(`DELETE FROM "archive"."payments" WHERE "id" = ANY($1)`, [seededPaymentIds]);
    }
    if (seededOutboxIds.length > 0) {
      await AppDataSource.query(`DELETE FROM "ledger_outbox" WHERE "id" = ANY($1)`, [seededOutboxIds]);
      await AppDataSource.query(`DELETE FROM "archive"."ledger_outbox" WHERE "id" = ANY($1)`, [seededOutboxIds]);
    }
    if (existsSync(backupPath)) {
      rmSync(backupPath, { recursive: true, force: true });
    }
    await AppDataSource.destroy();
  });

  async function seedPayment(opts: { status: string; daysOld: number; merchantId?: string }): Promise<string> {
    const id = randomUUID();
    await AppDataSource.query(
      `INSERT INTO "payments" (
         "id", "merchant_id", "amount_minor_units", "currency_code", "currency_minor_units",
         "status", "idempotency_key", "created_at", "updated_at"
       ) VALUES ($1, $2, 1000, 'USD', 2, $3, $4, now() - ($5 || ' days')::interval, now())`,
      [id, opts.merchantId ?? `merchant_${randomUUID()}`, opts.status, `idem_${id}`, opts.daysOld],
    );
    seededPaymentIds.push(id);
    return id;
  }

  async function seedOutboxEntry(opts: { status: string; daysOld: number; paymentId: string }): Promise<string> {
    const id = randomUUID();
    await AppDataSource.query(
      `INSERT INTO "ledger_outbox" ("id", "payment_id", "event_type", "entries", "status", "retry_count", "created_at")
       VALUES ($1, $2, 'PAYMENT_SUCCEEDED', '[]'::jsonb, $3, 0, now() - ($4 || ' days')::interval)`,
      [id, opts.paymentId, opts.status, opts.daysOld],
    );
    seededOutboxIds.push(id);
    return id;
  }

  it('archives a terminal, undisputed payment older than the threshold, and leaves recent ones untouched', async () => {
    const oldEligible = await seedPayment({ status: 'SUCCEEDED', daysOld: 200 });
    const tooRecent = await seedPayment({ status: 'SUCCEEDED', daysOld: 10 });
    const notTerminal = await seedPayment({ status: 'PENDING', daysOld: 200 });

    const before = await archivePayments();
    expect(before.eligible).toBeGreaterThanOrEqual(1);
    expect(before.archived).toBe(before.eligible);

    const archived = await AppDataSource.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [oldEligible]);
    expect(archived).toHaveLength(1);
    const stillLive = await AppDataSource.query(`SELECT "id" FROM "payments" WHERE "id" = $1`, [oldEligible]);
    expect(stillLive).toHaveLength(0);

    const recentStillLive = await AppDataSource.query(`SELECT "id" FROM "payments" WHERE "id" = $1`, [tooRecent]);
    expect(recentStillLive).toHaveLength(1);
    const pendingStillLive = await AppDataSource.query(`SELECT "id" FROM "payments" WHERE "id" = $1`, [notTerminal]);
    expect(pendingStillLive).toHaveLength(1);
  });

  it('excludes a payment with an open dispute even if it is old and terminal', async () => {
    const disputedId = await seedPayment({ status: 'SUCCEEDED', daysOld: 200 });
    const merchantRow = await AppDataSource.query(`SELECT "merchant_id" FROM "payments" WHERE "id" = $1`, [disputedId]);
    await AppDataSource.query(
      `INSERT INTO "disputes" ("id", "payment_id", "merchant_id", "psp_provider", "psp_dispute_id", "amount_minor_units", "currency_code", "status", "respond_by", "created_at", "updated_at")
       VALUES ($1, $2, $3, 'STRIPE', $4, 1000, 'USD', 'NEEDS_RESPONSE', now() + interval '7 days', now(), now())`,
      [randomUUID(), disputedId, merchantRow[0].merchant_id, `dp_${randomUUID()}`],
    );

    await archivePayments();

    const stillLive = await AppDataSource.query(`SELECT "id" FROM "payments" WHERE "id" = $1`, [disputedId]);
    expect(stillLive).toHaveLength(1);
    const notArchived = await AppDataSource.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [disputedId]);
    expect(notArchived).toHaveLength(0);

    await AppDataSource.query(`DELETE FROM "disputes" WHERE "payment_id" = $1`, [disputedId]);
  });

  it('archives a PUBLISHED ledger_outbox entry older than the threshold, but not a PENDING one', async () => {
    const paymentId = await seedPayment({ status: 'SUCCEEDED', daysOld: 200 });
    const published = await seedOutboxEntry({ status: 'PUBLISHED', daysOld: 200, paymentId });
    const pending = await seedOutboxEntry({ status: 'PENDING', daysOld: 200, paymentId });

    await archiveLedgerOutbox();

    const archived = await AppDataSource.query(`SELECT "id" FROM "archive"."ledger_outbox" WHERE "id" = $1`, [published]);
    expect(archived).toHaveLength(1);
    const stillLive = await AppDataSource.query(`SELECT "id" FROM "ledger_outbox" WHERE "id" = $1`, [pending]);
    expect(stillLive).toHaveLength(1);
  });

  it('deletes an archived payment past the deletion threshold and writes a backup file first', async () => {
    const id = randomUUID();
    await AppDataSource.query(
      `INSERT INTO "archive"."payments" (
         "id", "merchant_id", "amount_minor_units", "currency_code", "currency_minor_units",
         "status", "idempotency_key", "created_at", "updated_at"
       ) VALUES ($1, $2, 1000, 'USD', 2, 'SUCCEEDED', $3, now() - interval '9 years', now())`,
      [id, `merchant_${randomUUID()}`, `idem_${id}`],
    );
    seededPaymentIds.push(id);

    const originalPath = process.env.DELETION_BACKUP_PATH;
    process.env.DELETION_BACKUP_PATH = backupPath;
    try {
      const result = await runDeletion();
      expect(result.paymentsDeleted).toBeGreaterThanOrEqual(1);
      expect(result.backupFile).not.toBeNull();
      expect(existsSync(result.backupFile as string)).toBe(true);

      const backupContent = JSON.parse(require('fs').readFileSync(result.backupFile as string, 'utf8'));
      expect(backupContent.payments.some((p: { id: string }) => p.id === id)).toBe(true);

      const stillInArchive = await AppDataSource.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [id]);
      expect(stillInArchive).toHaveLength(0);
    } finally {
      process.env.DELETION_BACKUP_PATH = originalPath;
    }
  });

  it('does not delete anything if the backup path is unwritable', async () => {
    const id = randomUUID();
    await AppDataSource.query(
      `INSERT INTO "archive"."payments" (
         "id", "merchant_id", "amount_minor_units", "currency_code", "currency_minor_units",
         "status", "idempotency_key", "created_at", "updated_at"
       ) VALUES ($1, $2, 1000, 'USD', 2, 'SUCCEEDED', $3, now() - interval '9 years', now())`,
      [id, `merchant_${randomUUID()}`, `idem_${id}`],
    );
    seededPaymentIds.push(id);

    const originalPath = process.env.DELETION_BACKUP_PATH;
    // A path with a *regular file* as one of its components can never be
    // mkdir'd into (ENOTDIR) — reliable cross-platform way to force the
    // write to fail, independent of this test runner's actual OS
    // permissions (unlike pointing at a root-owned directory, which only
    // fails when the test happens to run as a non-root user).
    mkdirSync(backupPath, { recursive: true });
    const blockerFile = `${backupPath}/blocker-file`;
    writeFileSync(blockerFile, 'not a directory');
    process.env.DELETION_BACKUP_PATH = `${blockerFile}/subdir`;
    try {
      await expect(runDeletion()).rejects.toThrow();

      const stillInArchive = await AppDataSource.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [id]);
      expect(stillInArchive).toHaveLength(1);
    } finally {
      process.env.DELETION_BACKUP_PATH = originalPath;
    }
  });
});
