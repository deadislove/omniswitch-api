# Google Cloud Storage

`GcsBackupStorage` — `src/jobs/backup-storage/gcs-backup-storage.ts`.
Selected via `DELETION_BACKUP_STORAGE=gcs`. See
[`README.md`](./README.md) for the shape every provider shares
(interface, write-then-confirm, testing status) before reading the
provider-specific detail below.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DELETION_BACKUP_STORAGE` | Yes | Must be exactly `gcs` |
| `DELETION_BACKUP_GCS_BUCKET` | Yes | Bucket name, no `gs://` prefix |

No region variable — unlike S3, the `@google-cloud/storage` client
resolves the bucket's location from the bucket itself, not from local
configuration.

## Credentials

Never read directly by `GcsBackupStorage` — the client library
(`new Storage()`, no explicit config) resolves credentials via
Application Default Credentials (ADC), in its usual order: the
`GOOGLE_APPLICATION_CREDENTIALS` environment variable pointing at a
service-account key file, `gcloud auth application-default login`'s
cached credentials (local dev only), or the GKE/GCE metadata service.
**The recommended path in a real GKE deployment is Workload
Identity**: bind the k8s service account this job's pod runs as to a
GCP service account with `roles/storage.objectCreator` (or a custom
role scoped to just `storage.objects.create`/`storage.objects.get` on
the backup bucket) — no service-account key file to generate, rotate,
or leak. As with the S3/IRSA note, the deletion CronJob's manifest
would need its own `serviceAccountName` set to a k8s service account
annotated for Workload Identity binding — it doesn't specify one today.

## What the adapter actually does

```
file.save(body)  → uploads deletion-backup-<timestamp>.json
file.exists()    → confirms the object exists (throws if not)
returns            gs://<bucket>/deletion-backup-<timestamp>.json
```

Unlike the S3/Azure adapters (which let their SDK's own missing-object
error propagate directly), this adapter explicitly checks
`file.exists()` and throws its own descriptive error
(`GCS object gs://... was not written correctly`) if the check comes
back false — same end result (the write is treated as failed, nothing
gets deleted), a more direct error message.

## Suggested bucket setup (not provisioned by this codebase)

Same considerations as the S3 doc's equivalent section apply here:
object versioning, encryption (GCS encrypts at rest by default;
consider a customer-managed key — CMEK — if this deployment already
uses one elsewhere), a retention/lifecycle policy matching the
deployment's actual legal/audit requirement, and IAM restricted to the
specific service account this job runs as.

## Verifying a real deployment before relying on it

```bash
DELETION_BACKUP_STORAGE=gcs \
DELETION_BACKUP_GCS_BUCKET=your-test-bucket \
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
npm run job:delete
```

Confirm the object appears (`gsutil ls gs://your-test-bucket/`) and
that the job's log line reports `"status":"success"` with a
`backupFile` starting `gs://`. Test against a disposable bucket with
no real production data first — see
[`README.md#what-this-doesnt-cover`](./README.md#what-this-doesnt-cover)
for why this hasn't already been done as part of this project.
