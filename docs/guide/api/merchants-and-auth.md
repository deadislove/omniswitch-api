# Merchants & Auth API

Source: `auth.controller.ts`, `merchant-admin.controller.ts`. Read
[`business-domain-guide.md`](../business-domain-guide.md#1-what-this-system-actually-is)
for what a `Merchant` actually configures.

---

## Auth (`/auth`)

### `POST /auth/token`

Exchanges an API Key ID + Secret for a JWT. The only way to obtain a
token — everything else in this API requires one.

- **Public** (no auth required to call this one)
- **Rate limit**: stricter than normal (credential-guessing target),
  configurable via `AUTH_LOGIN_RATE_LIMIT`

**Body**: `{ apiKeyId: string, apiKeySecret: string }`

**Response `200`** (MFA disabled):
```json
{ "accessToken": "eyJ...", "tokenType": "Bearer", "expiresIn": 3600 }
```

**Response `200`** (MFA enabled): a short-lived (5 min), restricted
token that `JwtAuthGuard` rejects everywhere except
`POST /auth/mfa/verify`:
```json
{ "accessToken": "eyJ...", "tokenType": "Bearer", "expiresIn": 300, "mfaRequired": true }
```

- **Errors**: `401` invalid credentials (same message whether the key
  doesn't exist or the secret is wrong — doesn't leak which).

### `POST /auth/revoke`

Revokes the calling token immediately (logout) — same jti-based
mechanism `POST /delegations/:id/revoke` reuses for agent tokens.

- **Roles**: any authenticated caller
- **Response `200`**: `{ revoked: true }`

### `POST /auth/mfa/enroll`

Starts TOTP enrollment — generates a secret (not yet enforced until
confirmed).

- **Roles**: any authenticated caller
- **Response `200`**: `{ secret: string, otpauthUrl: string }` (render
  `otpauthUrl` as a QR code)
- **Errors**: `409` MFA already enabled.

### `POST /auth/mfa/confirm`

Confirms enrollment with a current TOTP code — enables MFA and returns
one-time backup codes.

- **Body**: `{ code: string }` (6-9 chars — TOTP or an unused backup
  code, `XXXX-XXXX` format)
- **Response `200`**: `{ backupCodes: string[] }` — shown once
- **Errors**: `401` invalid code; `409` no enrollment in progress.

### `POST /auth/mfa/disable`

Requires a valid TOTP/backup code — a stolen JWT alone can't turn MFA
off.

- **Body**: `{ code: string }`
- **Response `200`**: `{ disabled: true }`
- **Errors**: `401` invalid code; `409` MFA not enabled.

### `POST /auth/mfa/verify`

Trades a pending MFA token for a full one after proving a valid
TOTP/backup code. The pending token is revoked immediately after use
(defense in depth).

- **Body**: `{ code: string }`
- **Response `200`**: `TokenResponseDto` (a full, normal token)
- **Errors**: `401` invalid code; `409` MFA not enabled.

---

## Merchant Admin (`/admin/merchants`)

Everything below requires `ADMIN`.

### `GET /admin/merchants`

List every merchant (secrets never included).

### `POST /admin/merchants`

Onboards a new merchant — returns the API key secret **once**.

**Body**

| Field | Required | Notes |
|---|---|---|
| `merchantId` | yes | Business-facing id, `[a-zA-Z0-9_-]+`, 3-64 chars |
| `name` | yes | |
| `roles` | yes | Subset of `ADMIN`/`MERCHANT`/`OPERATOR`/`READONLY` |
| `platformFeeBps` | no | Default 150 (1.5%) |
| `settlementCurrency` | no | Default: settle in whatever currency was charged |
| `reserveBps` / `reserveHoldDays` | no | Per-charge reserve. Default 0 (none) |
| `accountType` | no | `PLATFORM` (default) or `CONNECTED` (requires `platformMerchantId`) |
| `platformMerchantId` | required iff `accountType: 'CONNECTED'` | |
| `payoutReserveBps` / `payoutReserveHoldDays` | no | Rolling payout reserve, `CONNECTED` merchants only |
| `enabledPspProviders` | no | PSPs this merchant may route charges through — `STRIPE`/`ADYEN`. Default: every PSP this system has an adapter for (currently both) |

**Response `201`**: merchant summary + `apiKeySecret` + `hmacSecret`
(both shown once).

- **Errors**: `409` `merchantId` already exists.

### `POST /admin/merchants/:id/rotate-api-key`

Rotates the API key secret — old one stops working immediately.

**Response `200`**: `{ merchantId, apiKeySecret }` — shown once.

### `POST /admin/merchants/:id/rotate-hmac-secret`

Rotates the HMAC signing key.

**Response `200`**: `{ merchantId, hmacSecret }` — shown once.

### `PATCH /admin/merchants/:id/status`

- **Body**: `{ isActive: boolean }` — deactivating also revokes every
  active session for this merchant.

### `PATCH /admin/merchants/:id/fee-rate`

- **Body**: `{ platformFeeBps: number }` (0-10,000). Takes effect on the
  next charge/capture — never retroactive.

### `PATCH /admin/merchants/:id/fee-tiers`

Sets (or, with an empty array, clears) a volume-based fee schedule that
supersedes `platformFeeBps` once trailing monthly volume crosses a
threshold. See
[`../business-domain-guide.md`](../business-domain-guide.md) and
[`../../business-domain/ledger-and-settlement.md#fee-model`](../../business-domain/ledger-and-settlement.md#fee-model).

- **Body**: `{ tiers: [{ minVolumeMinorUnits: string, bps: number }] }`
  — strictly ascending, no duplicate thresholds.
- **Errors**: `422` `FEE_TIER_NOT_ASCENDING` (thresholds not strictly
  ascending, or a duplicate) or `FEE_TIER_INVALID_THRESHOLD`
  (`minVolumeMinorUnits` isn't a valid integer string).

### `PATCH /admin/merchants/:id/settlement-currency`

- **Body**: `{ settlementCurrency?: string | null }` — omit/`null` to go
  back to settling in whatever currency was charged.

### `PATCH /admin/merchants/:id/reserve-policy`

- **Body**: `{ reserveBps: number, reserveHoldDays: number }` — setting
  this also flips `riskTierAutoManaged` to `false` (a manual override
  sticks until re-enabled).

### `PATCH /admin/merchants/:id/payout-reserve-policy`

- **Body**: `{ payoutReserveBps: number, payoutReserveHoldDays: number }`
  — the marketplace-payout equivalent of the above; only meaningful for
  a `CONNECTED` merchant.

### `PATCH /admin/merchants/:id/risk-tier-auto`

- **Body**: `{ enabled: boolean }` — re-enables `RiskTieringService`'s
  automatic management after a manual override.

### `POST /admin/merchants/:id/kyc/submit`

Submits (or re-submits) this merchant's KYC application — resolves
**synchronously** against the (mocked) KYC provider. Only meaningful for
a `CONNECTED` merchant; gates payout transfers, not charges.

- **Body**: `{ legalName: string, taxId: string }`

### `PATCH /admin/merchants/:id/psp-entitlement`

Sets which PSPs this merchant's charges may route through — takes
effect on the next charge. Not a global kill switch: narrowing one
merchant's entitlement doesn't affect any other merchant's ability to
use that PSP. See
[`../../business-domain/ledger-and-settlement.md#smart-psp-routing`](../../business-domain/ledger-and-settlement.md#smart-psp-routing).

- **Body**: `{ enabledPspProviders: string[] }` — non-empty, values
  restricted to `STRIPE`/`ADYEN`.
- **Errors**: `422` if `enabledPspProviders` is empty.

A charge (`POST /payments/charge`) whose `preferredProvider` names a
PSP outside this list is rejected with `422
PREFERRED_PROVIDER_NOT_ENTITLED` — not silently routed to a different
PSP. See [`payments.md`](./payments.md#post-paymentscharge).

All the `PATCH`/`POST` endpoints above (except onboarding/rotation)
return the merchant summary:

**`MerchantSummaryDto` shape**:

```json
{
  "merchantId": "merchant_acme_corp",
  "name": "Acme Corp",
  "apiKeyId": "ak_1a2b3c4d5e6f...",
  "roles": ["MERCHANT"],
  "isActive": true,
  "platformFeeBps": 150,
  "feeTiers": [{ "minVolumeMinorUnits": "1000000", "bps": 100 }],
  "settlementCurrency": null,
  "reserveBps": 0,
  "reserveHoldDays": 0,
  "riskTierAutoManaged": true,
  "accountType": "PLATFORM",
  "platformMerchantId": null,
  "payoutReserveBps": 0,
  "payoutReserveHoldDays": 0,
  "kycStatus": "NOT_STARTED",
  "enabledPspProviders": ["STRIPE", "ADYEN"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

Every endpoint in this section: `404` if `merchantId` doesn't exist.

### `POST /admin/merchants/:id/revoke-sessions`

Immediately invalidates every access token currently issued to this
merchant (the merchant-wide JWT revocation list — see
[`system-design.md`](../system-design.md#5-cross-cutting-infrastructure-concerns)).
Note this does **not**, on its own, revoke that merchant's outstanding
agent delegations separately — a delegation JWT carries the merchant's
own `merchantId`/`iat`, so it's covered by this same revocation check
automatically, with no special-casing needed.

**Response `200`**: `{ merchantId, revoked: true }`
