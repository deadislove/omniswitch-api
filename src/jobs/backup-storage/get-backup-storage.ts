import { BackupStorage } from './backup-storage.interface';
import { LocalDiskBackupStorage } from './local-disk-backup-storage';
import { S3BackupStorage } from './s3-backup-storage';
import { GcsBackupStorage } from './gcs-backup-storage';
import { AzureBlobBackupStorage } from './azure-blob-backup-storage';

/**
 * Selects which `BackupStorage` adapter `run-deletion-job.ts` writes
 * to, based on `DELETION_BACKUP_STORAGE` (default `"local"`).
 *
 * A plain factory function, not a NestJS-injected provider the way
 * `PaymentProcessorFactory` selects between PSP adapters —
 * `run-deletion-job.ts` is a standalone script that deliberately runs
 * outside the Nest DI container (see that file's own docblock for why),
 * so there is no module context here to register providers into.
 *
 * `"local"` is the default specifically so this project's GitHub
 * Actions CI — which never has real cloud credentials — keeps passing
 * with zero configuration; see docs/compliance/data-retention.md. A
 * real deployment opts into a cloud provider by setting
 * `DELETION_BACKUP_STORAGE` plus that provider's own config (checked
 * below; each is required only when its provider is actually selected,
 * so an unrelated provider's env vars being unset never blocks a
 * deployment that isn't using it).
 *
 * Throws synchronously (before any backup is attempted) if the
 * selected provider's required config is missing, or if the value
 * itself isn't a recognized provider — a typo here should fail loud at
 * job start, not surface later as an unexplained upload error.
 */
export function getBackupStorage(): BackupStorage {
  const provider = process.env.DELETION_BACKUP_STORAGE || 'local';

  switch (provider) {
    case 'local':
      return new LocalDiskBackupStorage(process.env.DELETION_BACKUP_PATH || './backups');

    case 's3': {
      const bucket = process.env.DELETION_BACKUP_S3_BUCKET;
      const region = process.env.DELETION_BACKUP_S3_REGION;
      if (!bucket || !region) {
        throw new Error('DELETION_BACKUP_STORAGE=s3 requires DELETION_BACKUP_S3_BUCKET and DELETION_BACKUP_S3_REGION');
      }
      return new S3BackupStorage(bucket, region);
    }

    case 'gcs': {
      const bucket = process.env.DELETION_BACKUP_GCS_BUCKET;
      if (!bucket) {
        throw new Error('DELETION_BACKUP_STORAGE=gcs requires DELETION_BACKUP_GCS_BUCKET');
      }
      return new GcsBackupStorage(bucket);
    }

    case 'azure': {
      const connectionString = process.env.DELETION_BACKUP_AZURE_CONNECTION_STRING;
      const container = process.env.DELETION_BACKUP_AZURE_CONTAINER;
      if (!connectionString || !container) {
        throw new Error('DELETION_BACKUP_STORAGE=azure requires DELETION_BACKUP_AZURE_CONNECTION_STRING and DELETION_BACKUP_AZURE_CONTAINER');
      }
      return new AzureBlobBackupStorage(connectionString, container);
    }

    default:
      throw new Error(`Unknown DELETION_BACKUP_STORAGE: "${provider}" (expected "local", "s3", "gcs", or "azure")`);
  }
}
