const mockSave = jest.fn();
const mockExists = jest.fn();
const mockFile = jest.fn().mockImplementation(() => ({ save: mockSave, exists: mockExists }));
const mockBucket = jest.fn().mockImplementation(() => ({ file: mockFile }));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: mockBucket })),
}));

import { GcsBackupStorage } from './gcs-backup-storage';

describe('GcsBackupStorage', () => {
  beforeEach(() => {
    mockSave.mockReset();
    mockExists.mockReset();
    mockFile.mockClear();
    mockBucket.mockClear();
  });

  it('uploads the records as one JSON object, confirms it exists, and returns a gs:// URI', async () => {
    mockSave.mockResolvedValue(undefined);
    mockExists.mockResolvedValue([true]);
    const storage = new GcsBackupStorage('my-bucket');
    const records = { payments: [{ id: 'p1' }], ledgerOutbox: [] };

    const result = await storage.write(records);

    expect(result).toMatch(/^gs:\/\/my-bucket\/deletion-backup-.*\.json$/);
    expect(mockBucket).toHaveBeenCalledWith('my-bucket');
    expect(JSON.parse(mockSave.mock.calls[0][0])).toEqual(records);
  });

  it('throws if the object does not exist after the upload', async () => {
    mockSave.mockResolvedValue(undefined);
    mockExists.mockResolvedValue([false]);
    const storage = new GcsBackupStorage('my-bucket');

    await expect(storage.write({ payments: [], ledgerOutbox: [] })).rejects.toThrow(/was not written correctly/);
  });
});
