const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'PutObjectCommand' })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'HeadObjectCommand' })),
}));

import { S3BackupStorage } from './s3-backup-storage';

describe('S3BackupStorage', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('uploads the records as one JSON object, confirms it with HeadObject, and returns an s3:// URI', async () => {
    mockSend.mockResolvedValue({});
    const storage = new S3BackupStorage('my-bucket', 'us-east-1');
    const records = { payments: [{ id: 'p1' }], ledgerOutbox: [] };

    const result = await storage.write(records);

    expect(result).toMatch(/^s3:\/\/my-bucket\/deletion-backup-.*\.json$/);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const putCall = mockSend.mock.calls[0][0];
    expect(putCall.__type).toBe('PutObjectCommand');
    expect(putCall.input.Bucket).toBe('my-bucket');
    expect(JSON.parse(putCall.input.Body)).toEqual(records);
    const headCall = mockSend.mock.calls[1][0];
    expect(headCall.__type).toBe('HeadObjectCommand');
    expect(headCall.input.Bucket).toBe('my-bucket');
  });

  it('propagates a rejection from the underlying client (e.g. the confirming HeadObject failing) without returning a value', async () => {
    mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('NotFound'));
    const storage = new S3BackupStorage('my-bucket', 'us-east-1');

    await expect(storage.write({ payments: [], ledgerOutbox: [] })).rejects.toThrow('NotFound');
  });
});
