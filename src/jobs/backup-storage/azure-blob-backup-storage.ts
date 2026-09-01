import { BlobServiceClient } from '@azure/storage-blob';
import { BackupStorage } from './backup-storage.interface';

/**
 * Azure Blob Storage — selected via `DELETION_BACKUP_STORAGE=azure`,
 * requires `DELETION_BACKUP_AZURE_CONNECTION_STRING`/
 * `DELETION_BACKUP_AZURE_CONTAINER` (see `get-backup-storage.ts`). A
 * connection string is the most portable of Azure Storage's several
 * auth options (SAS token, account key, Azure AD) — one clear default
 * here, consistent with this whole abstraction favoring one supported
 * path per provider over exposing every possible auth variant.
 *
 * Never exercised by this project's e2e suite or CI — see
 * `S3BackupStorage`'s docblock. Covered instead by
 * `azure-blob-backup-storage.spec.ts`, a unit test against a mocked
 * `BlobServiceClient`.
 */
export class AzureBlobBackupStorage implements BackupStorage {
  private readonly client: BlobServiceClient;

  constructor(connectionString: string, private readonly container: string) {
    this.client = BlobServiceClient.fromConnectionString(connectionString);
  }

  /**
   * Uploads the backup as one JSON blob, then checks the blob exists
   * before returning — same "confirm the write" principle as the other
   * adapters. Returns the blob's own URL.
   */
  async write(records: { payments: unknown[]; ledgerOutbox: unknown[] }): Promise<string> {
    const key = `deletion-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const body = JSON.stringify(records, null, 2);

    const blockBlobClient = this.client.getContainerClient(this.container).getBlockBlobClient(key);
    await blockBlobClient.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });

    const exists = await blockBlobClient.exists();
    if (!exists) {
      throw new Error(`Azure blob ${this.container}/${key} was not written correctly`);
    }
    return blockBlobClient.url;
  }
}
