import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalDiskBackupStorage } from './local-disk-backup-storage';

// This spec's fs paths all come from mkdtempSync()/tmpdir() — generated
// by this test file itself, not from any external input — so the
// non-literal-path finding here is the same class of false positive
// local-disk-backup-storage.ts's own eslint-disable comments explain;
// suppressed per-site for the same reason, not by disabling the rule.
describe('LocalDiskBackupStorage', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omniswitch-backup-test-'));
  });

  afterEach(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the records as JSON and returns the file path', async () => {
    const storage = new LocalDiskBackupStorage(dir);
    const records = { payments: [{ id: 'p1' }], ledgerOutbox: [{ id: 'l1' }] };

    const filePath = await storage.write(records);

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(filePath)).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(records);
  });

  it('creates the target directory if it does not exist yet', async () => {
    const nestedDir = join(dir, 'nested', 'path');
    const storage = new LocalDiskBackupStorage(nestedDir);

    const filePath = await storage.write({ payments: [], ledgerOutbox: [] });

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(filePath)).toBe(true);
  });

  it('throws if the target path cannot be written to', async () => {
    // A path with a *regular file* as one of its components can never
    // be mkdir'd into (ENOTDIR) — a reliable, platform-independent way
    // to force the write to fail.
    const blockerFile = join(dir, 'blocker-file');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(blockerFile, 'not a directory');
    const storage = new LocalDiskBackupStorage(join(blockerFile, 'subdir'));

    await expect(storage.write({ payments: [], ledgerOutbox: [] })).rejects.toThrow();
  });
});
