const mockUpload = jest.fn();
const mockExists = jest.fn();
const mockGetBlockBlobClient = jest.fn().mockImplementation((key: string) => ({
  upload: mockUpload,
  exists: mockExists,
  url: `https://test.blob.core.windows.net/my-container/${key}`,
}));
const mockGetContainerClient = jest.fn().mockImplementation(() => ({ getBlockBlobClient: mockGetBlockBlobClient }));
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn().mockImplementation(() => ({ getContainerClient: mockGetContainerClient })),
  },
}));

import { AzureBlobBackupStorage } from './azure-blob-backup-storage';

describe('AzureBlobBackupStorage', () => {
  beforeEach(() => {
    mockUpload.mockReset();
    mockExists.mockReset();
    mockGetBlockBlobClient.mockClear();
    mockGetContainerClient.mockClear();
  });

  it('uploads the records as one JSON blob, confirms it exists, and returns the blob URL', async () => {
    mockUpload.mockResolvedValue({});
    mockExists.mockResolvedValue(true);
    const storage = new AzureBlobBackupStorage('fake-connection-string', 'my-container');
    const records = { payments: [{ id: 'p1' }], ledgerOutbox: [] };

    const result = await storage.write(records);

    expect(result).toMatch(/^https:\/\/test\.blob\.core\.windows\.net\/my-container\/deletion-backup-.*\.json$/);
    expect(mockGetContainerClient).toHaveBeenCalledWith('my-container');
    expect(JSON.parse(mockUpload.mock.calls[0][0])).toEqual(records);
  });

  it('throws if the blob does not exist after the upload', async () => {
    mockUpload.mockResolvedValue({});
    mockExists.mockResolvedValue(false);
    const storage = new AzureBlobBackupStorage('fake-connection-string', 'my-container');

    await expect(storage.write({ payments: [], ledgerOutbox: [] })).rejects.toThrow(/was not written correctly/);
  });
});
