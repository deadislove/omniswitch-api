import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { BackupStorage } from './backup-storage.interface';

/**
 * AWS S3 — selected via `DELETION_BACKUP_STORAGE=s3`, requires
 * `DELETION_BACKUP_S3_BUCKET`/`DELETION_BACKUP_S3_REGION` (see
 * `get-backup-storage.ts`). Credentials are never read directly by
 * this class — the AWS SDK's own default credential provider chain
 * handles that (an IAM role for a service account, an instance
 * profile, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` if a
 * deployment sets those explicitly), the same "defer to the platform's
 * standard mechanism rather than inventing one" reasoning this codebase
 * already applies to Vault token handling (`VaultTransitService`) —
 * this class's own config is only the bucket and region.
 *
 * Never exercised by this project's e2e suite or CI, since neither has
 * real AWS credentials available — see
 * docs/compliance/data-retention.md. Covered instead by
 * `s3-backup-storage.spec.ts`, a unit test against a mocked `S3Client`.
 */
export class S3BackupStorage implements BackupStorage {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, region: string) {
    this.client = new S3Client({ region });
  }

  /**
   * Uploads the backup as one JSON object, then issues a HeadObject
   * call to confirm it actually landed before returning — mirrors
   * `LocalDiskBackupStorage`'s "confirm the write, don't trust a
   * silent failure" check; `HeadObjectCommand` rejects if the object
   * isn't there, which propagates as this method throwing. Returns the
   * object's `s3://bucket/key` URI.
   */
  async write(records: { payments: unknown[]; ledgerOutbox: unknown[] }): Promise<string> {
    const key = `deletion-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const body = JSON.stringify(records, null, 2);

    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json' }),
    );
    await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));

    return `s3://${this.bucket}/${key}`;
  }
}
