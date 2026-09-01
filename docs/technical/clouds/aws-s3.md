# AWS S3

`S3BackupStorage` — `src/jobs/backup-storage/s3-backup-storage.ts`.
Selected via `DELETION_BACKUP_STORAGE=s3`. See
[`README.md`](./README.md) for the shape every provider shares
(interface, write-then-confirm, testing status) before reading the
provider-specific detail below.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DELETION_BACKUP_STORAGE` | Yes | Must be exactly `s3` |
| `DELETION_BACKUP_S3_BUCKET` | Yes | Bucket name, no `s3://` prefix |
| `DELETION_BACKUP_S3_REGION` | Yes | e.g. `us-east-1` — the SDK client is constructed with this region explicitly, not inferred from the bucket |

Both `DELETION_BACKUP_S3_BUCKET`/`DELETION_BACKUP_S3_REGION` go in
`k8s/configmap.yaml` (or the local `.env.local`) — neither is a
credential. Set them via `.env.example`'s commented-out `s3` block as
a starting point.

## Credentials

Never read directly by `S3BackupStorage` — the AWS SDK v3
(`@aws-sdk/client-s3`)'s own default credential provider chain handles
resolution, in its usual order: environment variables
(`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`), a
shared credentials/config file, then an IAM role — an EC2 instance
profile, an ECS task role, or an IRSA (IAM Roles for Service Accounts)
binding if this job's pod runs on EKS. **The recommended path in a
real EKS deployment is IRSA**: bind `omniswitch-api-sa` (or a
dedicated service account for the CronJob pods specifically) to an IAM
role scoped to `s3:PutObject`/`s3:GetObject` on just the backup
bucket — no static keys to rotate or leak. `k8s/deployment.yaml`
already runs under `serviceAccountName: omniswitch-api-sa`; the
CronJob/Job manifests for the deletion job would need their own
`serviceAccountName` added if IRSA is the chosen path, since they
don't currently specify one (defaulting to the namespace's `default`
service account, which is not what you want for a real deployment
using IRSA).

## What the adapter actually does

```
PutObjectCommand  → uploads deletion-backup-<timestamp>.json
HeadObjectCommand → confirms the object exists (throws if not)
returns            s3://<bucket>/deletion-backup-<timestamp>.json
```

A `HeadObjectCommand` failure (object not found, or a permissions
error on the head call itself) propagates as a thrown error out of
`write()` — `run-deletion-job.ts` treats this exactly like a backup
failure from any other provider: nothing gets deleted from
`archive.payments`/`archive.ledger_outbox` for that run.

## Suggested bucket setup (not provisioned by this codebase)

This project's adapter writes objects; it doesn't configure the bucket
itself. Before pointing a real deployment's deletion job at a bucket,
consider:

- **Versioning enabled** — a backup bucket is the last line of defense
  before permanent deletion; accidental overwrite protection matters
  here more than most buckets.
- **Server-side encryption** (SSE-S3 or SSE-KMS) — these backups
  contain the same payment/ledger data the live database holds.
- **A lifecycle policy** matching (or exceeding) whatever legal/audit
  retention this backup is meant to satisfy — this codebase's deletion
  job writes once and never re-reads or expires these objects itself.
- **Bucket policy restricting access** to the IAM principal this job
  runs as, plus whichever operators need audit access — not broad
  account-wide read/write.

## Verifying a real deployment before relying on it

```bash
DELETION_BACKUP_STORAGE=s3 \
DELETION_BACKUP_S3_BUCKET=your-test-bucket \
DELETION_BACKUP_S3_REGION=us-east-1 \
npm run job:delete
```

Confirm the object actually appears in the bucket (`aws s3 ls
s3://your-test-bucket/`) and that the job's log line reports
`"status":"success"` with a `backupFile` starting `s3://`. Test against
a disposable bucket with no real production data first — see
[`README.md#what-this-doesnt-cover`](./README.md#what-this-doesnt-cover)
for why this hasn't already been done as part of this project.
