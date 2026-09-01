# Cloud Providers

The only cloud-provider-specific code in this project is the
pluggable `BackupStorage` abstraction the deletion job writes its
pre-delete export to (`src/jobs/backup-storage/`) — this project
doesn't provision cloud infrastructure itself (no Terraform/Pulumi in
this repo) or integrate with a cloud provider anywhere else. This
folder documents that one integration point, one file per supported
provider:

- [`aws-s3.md`](./aws-s3.md) — `S3BackupStorage`, `DELETION_BACKUP_STORAGE=s3`
- [`gcp-gcs.md`](./gcp-gcs.md) — `GcsBackupStorage`, `DELETION_BACKUP_STORAGE=gcs`
- [`azure-blob.md`](./azure-blob.md) — `AzureBlobBackupStorage`, `DELETION_BACKUP_STORAGE=azure`

For the business/compliance reasoning behind *why* the deletion job
backs up before deleting at all, see
[`../../compliance/data-retention.md`](../../compliance/data-retention.md).
For the job that actually calls this abstraction, see
[`../jobs.md`](../jobs.md) and
[`../../guide/jobs/data-retention-jobs.md`](../../guide/jobs/data-retention-jobs.md).

## The common shape

All three adapters implement the same interface
(`src/jobs/backup-storage/backup-storage.interface.ts`):

```ts
export interface BackupStorage {
  write(records: { payments: unknown[]; ledgerOutbox: unknown[] }): Promise<string>;
}
```

`write()` uploads the records as one JSON object/blob, then performs a
**second call to confirm the write actually landed** before returning
(`HeadObjectCommand` for S3, `file.exists()` for GCS,
`blockBlobClient.exists()` for Azure) — the same "don't trust a silent
failure" principle `LocalDiskBackupStorage` applies via `statSync()`.
The returned string is a location identifier in that provider's own
native format — `s3://bucket/key`, `gs://bucket/key`, or the blob's own
HTTPS URL for Azure — logged in the deletion job's run summary
(`backupFile` field) so an operator can locate the export later.

## Selecting a provider

One environment variable, `DELETION_BACKUP_STORAGE` (`local` default,
or `s3`/`gcs`/`azure`), read by the factory function
`src/jobs/backup-storage/get-backup-storage.ts` — see
[`../jobs.md#the-backupstorage-factory-di-pattern-doesnt-apply-here`](../jobs.md#the-backupstorage-factory-di-pattern-doesnt-apply-here)
for why this is a plain function rather than a NestJS-injected
provider. Each provider's own required config is validated eagerly,
at factory-call time — a missing bucket name or connection string
throws immediately, before the job attempts any backup, rather than
surfacing later as an unexplained upload failure.

## Why `local` is the default, not one of these three

This project's GitHub Actions CI never has real cloud credentials
available for any provider — provisioning them for a public reference
project would be a real security and cost liability. `local` (a
PVC-mounted filesystem path in k8s, a plain directory in local dev)
needs nothing but filesystem access, so it's what keeps CI green with
zero external configuration. Enabling a cloud provider is a real
deployment's own deliberate, opt-in decision at deploy time — see
[`../../compliance/data-retention.md#where-the-backup-goes`](../../compliance/data-retention.md#where-the-backup-goes)
for the fuller reasoning, including why a self-hosted stand-in (e.g.
MinIO in CI) was considered and not pursued — that's a new
architectural commitment for this project, not a small config change.

## Credentials: always the platform's own default mechanism, never a bespoke one

None of the three adapters read an access key/secret directly as their
own config. Each defers entirely to that cloud SDK's own standard
credential resolution — an IAM role or `AWS_ACCESS_KEY_ID`/
`AWS_SECRET_ACCESS_KEY` for AWS, Application Default Credentials for
GCP, a connection string for Azure (see each provider's own doc for
specifics). This mirrors how this codebase already handles Vault
token access (`VaultTransitService`) — defer to the platform's
standard mechanism rather than inventing a project-specific one. A
provider's own doc in this folder covers exactly which env
vars/mechanism it needs.

## What this doesn't cover

**None of the three cloud adapters have ever been run against a real
bucket or container.** No real AWS/GCP/Azure credentials exist
anywhere in this project's CI or local dev setup — see
[`../jobs.md#testing`](../jobs.md#testing). Each is covered by a unit
test against a mocked SDK client (confirms the adapter calls its SDK
correctly and propagates a failure as a thrown error — the same
"refuse to delete if the backup isn't confirmed" contract the `local`
adapter has, proven with a real filesystem), but that's a narrower
guarantee than an actual live upload. A deployment enabling one of
these for the first time should do its own live verification run
(`npm run job:delete` against a real, disposable bucket/container)
before depending on it in production — see each provider's own doc for
a suggested verification checklist.

**Bucket/container-level policy is out of scope for this codebase.**
Versioning, encryption-at-rest, access logging, retention/lifecycle
rules, chain-of-custody for a legal request — these adapters write to
whatever bucket/container is configured; they don't provision or
configure that bucket's own policies. That's infrastructure-as-code
territory, and a real deployment's own decision.
