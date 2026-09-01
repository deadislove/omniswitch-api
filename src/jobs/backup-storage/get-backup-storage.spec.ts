import { getBackupStorage } from './get-backup-storage';
import { LocalDiskBackupStorage } from './local-disk-backup-storage';
import { S3BackupStorage } from './s3-backup-storage';
import { GcsBackupStorage } from './gcs-backup-storage';
import { AzureBlobBackupStorage } from './azure-blob-backup-storage';

describe('getBackupStorage', () => {
  const ENV_KEYS = [
    'DELETION_BACKUP_STORAGE',
    'DELETION_BACKUP_PATH',
    'DELETION_BACKUP_S3_BUCKET',
    'DELETION_BACKUP_S3_REGION',
    'DELETION_BACKUP_GCS_BUCKET',
    'DELETION_BACKUP_AZURE_CONNECTION_STRING',
    'DELETION_BACKUP_AZURE_CONTAINER',
  ];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('defaults to LocalDiskBackupStorage when DELETION_BACKUP_STORAGE is unset', () => {
    expect(getBackupStorage()).toBeInstanceOf(LocalDiskBackupStorage);
  });

  it('selects LocalDiskBackupStorage explicitly for "local"', () => {
    process.env.DELETION_BACKUP_STORAGE = 'local';
    expect(getBackupStorage()).toBeInstanceOf(LocalDiskBackupStorage);
  });

  it('selects S3BackupStorage when bucket and region are set', () => {
    process.env.DELETION_BACKUP_STORAGE = 's3';
    process.env.DELETION_BACKUP_S3_BUCKET = 'my-bucket';
    process.env.DELETION_BACKUP_S3_REGION = 'us-east-1';
    expect(getBackupStorage()).toBeInstanceOf(S3BackupStorage);
  });

  it('throws for "s3" without the required bucket/region', () => {
    process.env.DELETION_BACKUP_STORAGE = 's3';
    expect(() => getBackupStorage()).toThrow(/DELETION_BACKUP_S3_BUCKET/);
  });

  it('selects GcsBackupStorage when bucket is set', () => {
    process.env.DELETION_BACKUP_STORAGE = 'gcs';
    process.env.DELETION_BACKUP_GCS_BUCKET = 'my-bucket';
    expect(getBackupStorage()).toBeInstanceOf(GcsBackupStorage);
  });

  it('throws for "gcs" without the required bucket', () => {
    process.env.DELETION_BACKUP_STORAGE = 'gcs';
    expect(() => getBackupStorage()).toThrow(/DELETION_BACKUP_GCS_BUCKET/);
  });

  it('selects AzureBlobBackupStorage when connection string and container are set', () => {
    process.env.DELETION_BACKUP_STORAGE = 'azure';
    process.env.DELETION_BACKUP_AZURE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net';
    process.env.DELETION_BACKUP_AZURE_CONTAINER = 'my-container';
    expect(getBackupStorage()).toBeInstanceOf(AzureBlobBackupStorage);
  });

  it('throws for "azure" without the required connection string/container', () => {
    process.env.DELETION_BACKUP_STORAGE = 'azure';
    expect(() => getBackupStorage()).toThrow(/DELETION_BACKUP_AZURE_CONNECTION_STRING/);
  });

  it('throws for an unrecognized provider', () => {
    process.env.DELETION_BACKUP_STORAGE = 'dropbox';
    expect(() => getBackupStorage()).toThrow(/Unknown DELETION_BACKUP_STORAGE/);
  });
});
