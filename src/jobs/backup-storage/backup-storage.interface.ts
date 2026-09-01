/**
 * A destination for the deletion job's pre-delete export (Phase 3
 * follow-up #4 — see docs/compliance/data-retention.md). One
 * implementation per supported provider, selected at runtime by
 * `getBackupStorage()`.
 */
export interface BackupStorage {
  /**
   * Writes `records` as the backup for one deletion run and returns a
   * location identifier for what was written — a local filesystem path
   * for `LocalDiskBackupStorage`, or an object-store URI (`s3://...`,
   * `gs://...`, the blob's URL) for the cloud adapters. This becomes
   * `run-deletion-job.ts`'s `backupFile` field, which is logged in the
   * job's run summary and asserted on directly by
   * `data-retention-jobs.e2e-spec.ts`.
   *
   * Must throw, not return a falsy or ambiguous value, if the write
   * can't be confirmed — `run-deletion-job.ts` treats any thrown error
   * here as "do not delete anything this run" (see
   * `DELETION_BACKUP_REQUIRED`), so a silent partial failure here would
   * silently defeat that safeguard.
   */
  write(records: { payments: unknown[]; ledgerOutbox: unknown[] }): Promise<string>;
}
