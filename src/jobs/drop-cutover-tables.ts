import 'dotenv/config';
import { AppDataSource } from '../database/data-source';

/**
 * One-time operator script — NOT a k8s CronJob, unlike
 * run-archiving-job.ts/run-deletion-job.ts. Dropping `payments_old`/
 * `ledger_outbox_old` (the pre-partitioning flat tables kept as a
 * cutover safety net — see docs/compliance/data-retention.md) is a
 * single event in this project's history, not a recurring policy
 * action, so it doesn't belong on a schedule the way archiving/deletion
 * do.
 *
 * Every row in `payments_old`/`ledger_outbox_old` is a byte-for-byte
 * duplicate of what the backfill already copied into the live
 * partitioned tables — dropping these tables loses no data that isn't
 * already tracked (and governed by the archive/deletion policy) through
 * `payments`/`ledger_outbox`/`archive.*`. Keeping them around
 * *indefinitely* would actually be worse for the retention policy's own
 * integrity than dropping them promptly: an ungoverned duplicate that
 * never ages out via the archiving/deletion jobs is a backdoor around
 * the deletion tier, not an extra safety measure.
 *
 * `CUTOVER_OLD_TABLE_RETENTION_DAYS` (default 60) is intentionally a
 * short, separate window from `ARCHIVE_THRESHOLD_DAYS`/
 * `DELETION_THRESHOLD_YEARS` — it answers "has enough time passed to
 * trust the cutover itself was correct," not an AML retention question.
 */

const CUTOVER_OLD_TABLE_RETENTION_DAYS = Number(process.env.CUTOVER_OLD_TABLE_RETENTION_DAYS) || 60;

interface TableStatus {
  tableName: string;
  cutoverAt: string;
  daysSinceCutover: number;
  eligible: boolean;
  dropped: boolean;
}

export async function dropCutoverTables(): Promise<TableStatus[]> {
  const rows = await AppDataSource.query(
    `SELECT "table_name", "cutover_at", EXTRACT(DAY FROM now() - "cutover_at") AS days_since_cutover
     FROM "schema_cutover_log"`,
  );

  const results: TableStatus[] = [];
  for (const row of rows) {
    const daysSinceCutover = Number(row.days_since_cutover);
    const eligible = daysSinceCutover >= CUTOVER_OLD_TABLE_RETENTION_DAYS;
    let dropped = false;

    if (eligible) {
      // Table might already have been dropped in a previous run without
      // its schema_cutover_log row being cleaned up (shouldn't happen —
      // see main() — but IF EXISTS keeps a re-run safe regardless).
      await AppDataSource.query(`DROP TABLE IF EXISTS "${row.table_name}"`);
      await AppDataSource.query(`DELETE FROM "schema_cutover_log" WHERE "table_name" = $1`, [row.table_name]);
      dropped = true;
    }

    results.push({
      tableName: row.table_name,
      cutoverAt: row.cutover_at,
      daysSinceCutover,
      eligible,
      dropped,
    });
  }
  return results;
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    const results = await dropCutoverTables();
    for (const r of results) {
      if (r.dropped) {
        console.log(`Dropped "${r.tableName}" (${r.daysSinceCutover} days since cutover, retention window ${CUTOVER_OLD_TABLE_RETENTION_DAYS} days).`);
      } else {
        console.log(
          `"${r.tableName}" not eligible yet — ${r.daysSinceCutover}/${CUTOVER_OLD_TABLE_RETENTION_DAYS} days since cutover (${CUTOVER_OLD_TABLE_RETENTION_DAYS - r.daysSinceCutover} day(s) remaining).`,
        );
      }
    }
    if (results.length === 0) {
      console.log('No cutover tables tracked (already dropped, or this project never went through a partitioning cutover).');
    }
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('drop-cutover-tables failed:', err);
    process.exit(1);
  });
}
