import { Storage } from '@google-cloud/storage';
import { BackupStorage } from './backup-storage.interface';

/**
 * Google Cloud Storage — selected via `DELETION_BACKUP_STORAGE=gcs`,
 * requires `DELETION_BACKUP_GCS_BUCKET` (see `get-backup-storage.ts`).
 * Credentials via the client library's Application Default Credentials
 * (`GOOGLE_APPLICATION_CREDENTIALS`, Workload Identity, or the GCE/GKE
 * metadata service) — same "defer to the platform's standard
 * mechanism" reasoning as `S3BackupStorage`.
 *
 * Never exercised by this project's e2e suite or CI — see
 * `S3BackupStorage`'s docblock. Covered instead by
 * `gcs-backup-storage.spec.ts`, a unit test against a mocked `Storage`
 * client.
 */
export class GcsBackupStorage implements BackupStorage {
  private readonly storage = new Storage();

  constructor(private readonly bucket: string) {}

  /**
   * Uploads the backup as one JSON object, then checks the object
   * exists before returning — same "confirm the write" principle as
   * `LocalDiskBackupStorage`/`S3BackupStorage`. Returns the object's
   * `gs://bucket/key` URI.
   */
  async write(records: { payments: unknown[]; ledgerOutbox: unknown[] }): Promise<string> {
    const key = `deletion-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const body = JSON.stringify(records, null, 2);

    const file = this.storage.bucket(this.bucket).file(key);
    await file.save(body, { contentType: 'application/json' });

    const [exists] = await file.exists();
    if (!exists) {
      throw new Error(`GCS object gs://${this.bucket}/${key} was not written correctly`);
    }
    return `gs://${this.bucket}/${key}`;
  }
}
