# Azure Blob Storage

`AzureBlobBackupStorage` — `src/jobs/backup-storage/azure-blob-backup-storage.ts`.
Selected via `DELETION_BACKUP_STORAGE=azure`. See
[`README.md`](./README.md) for the shape every provider shares
(interface, write-then-confirm, testing status) before reading the
provider-specific detail below.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DELETION_BACKUP_STORAGE` | Yes | Must be exactly `azure` |
| `DELETION_BACKUP_AZURE_CONNECTION_STRING` | Yes | Carries the storage account name **and** an access credential — this belongs in `omniswitch-secrets`, not `k8s/configmap.yaml`, unlike every other provider's config |
| `DELETION_BACKUP_AZURE_CONTAINER` | Yes | Blob container name |

## Credentials: a connection string, by deliberate choice

Unlike the S3/GCS adapters, this one takes its credential directly as
config (`BlobServiceClient.fromConnectionString(connectionString)`) —
Azure Storage supports several other auth mechanisms (a SAS token, a
raw account key, Azure AD/Entra ID service principal), and a connection
string is the most portable and universally-supported one to expose as
a single required setting. This is consistent with this whole
abstraction's design: one clear, supported path per provider, rather
than every possible auth variant each provider offers. A real
deployment preferring Azure AD-based auth (no long-lived secret in a
Kubernetes Secret at all) would need to swap `fromConnectionString()`
for a `DefaultAzureCredential`-based constructor — not currently
built, since it wasn't the path this project's minimal-viable-provider
scope chose to implement.

**Because a connection string is a credential, not just config**, it
must go in `omniswitch-secrets` (`secretKeyRef`), the same way
`DB_PASSWORD`/`JWT_SECRET` do — never in `k8s/configmap.yaml` alongside
`DELETION_BACKUP_AZURE_CONTAINER`, which is plain config. This is the
one provider where the config/secret split matters within a single
provider's own settings (S3/GCS keep all their required variables as
plain config, deferring the actual credential entirely to the SDK's
own external resolution — see [`README.md`](./README.md#credentials-always-the-platforms-own-default-mechanism-never-a-bespoke-one)).

## What the adapter actually does

```
blockBlobClient.upload(body, length)  → uploads deletion-backup-<timestamp>.json
blockBlobClient.exists()              → confirms the blob exists (throws if not)
returns                                 the blob's own .url (an HTTPS URL, not a azure:// URI)
```

The returned identifier is the blob client's own `.url` property (a
real, resolvable HTTPS URL against the storage account), unlike the
`s3://`/`gs://` URI scheme the other two adapters return — this is
what Azure's SDK naturally exposes, kept as-is rather than
reformatted into an invented `azure://` scheme.

## Suggested container setup (not provisioned by this codebase)

Same considerations as the other two providers: blob versioning
(Azure's "blob versioning" or soft-delete feature), encryption at rest
(enabled by default for Azure Storage; consider a customer-managed key
if this deployment already uses Azure Key Vault elsewhere), a
lifecycle management policy matching the deployment's actual retention
requirement, and access restricted to whichever identity holds the
connection string (rotate it via `omniswitch-secrets` if it's ever
exposed).

## Verifying a real deployment before relying on it

```bash
DELETION_BACKUP_STORAGE=azure \
DELETION_BACKUP_AZURE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=..." \
DELETION_BACKUP_AZURE_CONTAINER=your-test-container \
npm run job:delete
```

Confirm the blob appears (Azure Storage Explorer, or `az storage blob
list --container-name your-test-container`) and that the job's log
line reports `"status":"success"` with a `backupFile` that's a real,
resolvable HTTPS URL. Test against a disposable container with no real
production data first — see
[`README.md#what-this-doesnt-cover`](./README.md#what-this-doesnt-cover)
for why this hasn't already been done as part of this project.
