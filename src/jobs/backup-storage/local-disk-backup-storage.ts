import { existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { BackupStorage } from './backup-storage.interface';

/**
 * Writes to a local filesystem path — the default `BackupStorage`
 * (selected when `DELETION_BACKUP_STORAGE` is unset), because this
 * project's GitHub Actions CI never has real cloud credentials
 * available and must keep passing with zero external configuration
 * (see docs/compliance/data-retention.md). In production, this same
 * path is a `PersistentVolumeClaim` (`k8s/deletion-cronjob.yaml`) so
 * the file survives the CronJob pod's own lifecycle — an ephemeral
 * pod's local filesystem disappears with it otherwise.
 */
export class LocalDiskBackupStorage implements BackupStorage {
  constructor(private readonly backupPath: string) {}

  // Every fs call below has a non-literal path, which
  // security/detect-non-literal-fs-filename flags on principle — it
  // can't tell a path built from trusted config apart from one built
  // from attacker-reachable input. Here it's neither: `backupPath` only
  // ever comes from `DELETION_BACKUP_PATH`, an operator/deployment-time
  // env var (k8s configmap, or a local shell env) — the same trust
  // level as `DB_MASTER_HOST` or any other config this service reads,
  // never anything from an HTTP request or data this service
  // processes. The filename is generated entirely from
  // `Date.now()`/`toISOString()`, with no external input and no `/`/`..`
  // characters possible after the regex replace. Suppressed per-site
  // with this justification, not by disabling the rule — see
  // .eslintrc.security.cjs's own comment on why this rule (unlike
  // detect-object-injection) has a low false-positive rate and stays
  // enabled for everything else in this codebase.
  async write(records: { payments: unknown[]; ledgerOutbox: unknown[] }): Promise<string> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!existsSync(this.backupPath)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      mkdirSync(this.backupPath, { recursive: true });
    }
    const filename = `deletion-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = join(this.backupPath, filename);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(filePath, JSON.stringify(records, null, 2));

    // Confirm the file actually landed on disk with real content before
    // treating the backup as successful — a write that silently
    // truncated (disk full, permission race) must not be treated as
    // "backed up."
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!existsSync(filePath) || statSync(filePath).size === 0) {
      throw new Error(`Backup file ${filePath} was not written correctly (missing or empty)`);
    }
    return filePath;
  }
}
