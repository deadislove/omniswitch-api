# Agentic Payments API

Source: `delegation.controller.ts`. Read
[`business-domain-guide.md`](../business-domain-guide.md#10-agentic-payments-delegation--spend-policy)
first — this is the newest, least-obvious domain concept in this
system.

A `Delegation` is how a merchant authorizes an autonomous agent to
charge on its behalf, within a spend policy, without handing over its
own full-access credential. Creating one returns an agent JWT
(`UserRole.AGENT`) usable **only** against `POST /payments/charge` (see
[`payments.md`](./payments.md)) — every other endpoint in this API
rejects that token with a plain 403.

## `POST /delegations`

Authorizes a new agent with its own spend policy.

- **Roles**: `MERCHANT`, `ADMIN`
- No HMAC/idempotency — creating a delegation never moves money by
  itself.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `agentName` | string | yes | Human-readable label |
| `perTransactionLimit` | number | yes | Major currency units |
| `monthlyLimit` | number | yes | Must be ≥ `perTransactionLimit` |
| `currency` | string | yes | Both limits and every charge this agent makes must be this currency |
| `allowedCategories` | string[] | no | If set, `ChargePaymentDto.category` must match one of these; omitted entirely means any category is allowed |
| `tokenTtlSeconds` | int | no | Default 86400 (24h). Independent of the delegation itself, which stays `ACTIVE` — and revocable — regardless of token expiry |
| `requireApprovalAboveAmount` | number | no | Must not exceed `perTransactionLimit`. A charge above this amount doesn't auto-execute — see "Human-approval hold" below. Omitted entirely means no approval gate: every charge within the other limits auto-executes exactly as before |

**Response `201`**:

```json
{
  "delegation": {
    "id": "a1b2c3d4-...",
    "merchantId": "merchant_acme_corp",
    "agentName": "Shopping Assistant",
    "status": "ACTIVE",
    "perTransactionLimit": 50,
    "monthlyLimit": 500,
    "currency": "USD",
    "allowedCategories": ["groceries"],
    "requireApprovalAboveAmount": 200,
    "currentMonthSpent": 0,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "revokedAt": null,
    "updatedAt": "2026-01-01T00:00:00.000Z"
  },
  "agentToken": "eyJhbGciOiJIUzI1NiIs...",
  "agentSigningKey": "dlg_sign_9f2a1c...",
  "tokenType": "Bearer",
  "expiresIn": 86400
}
```

**`agentToken` and `agentSigningKey` are each shown exactly once** —
same posture as an API key secret. There's no "retrieve it again later"
endpoint; if either is lost, revoke the delegation and create a new one.

**`agentSigningKey` is required for every charge this agent makes.**
`POST /payments/charge` is HMAC-signed for every role, `AGENT` included
— an `AGENT` caller signs with this delegation's own
`agentSigningKey` instead of the merchant's HMAC secret (same signature
scheme, just keyed by delegation instead of merchant; see
[`payments.md`](./payments.md)). A charge signed with the wrong key, or
not signed at all, is rejected by the same HMAC guard every other
caller goes through.

## `GET /delegations/:id`

- **Roles**: `MERCHANT`, `ADMIN`, `OPERATOR`, `READONLY`
- **Errors**: `403` belongs to a different merchant; `404` not found.

## `GET /delegations`

List, optionally filtered by `merchantId` (non-`MERCHANT` roles only)
and `status` (`ACTIVE`/`REVOKED`).

- **Roles**: `MERCHANT`, `ADMIN`, `OPERATOR`, `READONLY`

## `POST /delegations/:id/revoke`

Revokes a delegation. **Takes effect immediately** — the agent's JWT is
rejected on its very next request (`401 TOKEN_REVOKED`), not just once
it naturally expires. Reuses the exact same JWT jti-revocation mechanism
`POST /auth/revoke` (logout) uses; see
[`system-design.md`](../system-design.md#5-cross-cutting-infrastructure-concerns).

- **Roles**: `MERCHANT`, `ADMIN`
- **Errors**: `403` wrong merchant; `404` not found; `409` already
  revoked.

## How spend-policy enforcement shows up on `POST /payments/charge`

When the caller is an `AGENT`, the charge amount/category is checked
against, and atomically reserved from, the delegation's spend policy
*before* the checkout saga ever calls a PSP:

| Violation | Status | `code` |
|---|---|---|
| Amount exceeds `perTransactionLimit` | 422 | `DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED` |
| Would exceed the rolling monthly budget | 422 | `DELEGATION_MONTHLY_LIMIT_EXCEEDED` |
| `category` not in `allowedCategories` | 422 | `DELEGATION_CATEGORY_NOT_ALLOWED` |
| Charge currency ≠ delegation's currency | 422 | `DELEGATION_CURRENCY_MISMATCH` |
| Delegation has been revoked | 403 | `DELEGATION_REVOKED` |
| Lost a race with a concurrent charge against the same delegation (the checks above passed against a now-stale read) | 422 | `DELEGATION_SPEND_LIMIT_EXCEEDED` |

None of these create a `Payment` row — the reservation happens before
Step 1 of the saga. A charge that goes on to actually decline at the PSP
releases its reservation, so a declined attempt doesn't permanently eat
into the agent's monthly budget; a successful (or still-pending, e.g.
`REQUIRES_ACTION`) charge keeps it reserved.

## Human-approval hold for above-threshold purchases

If the delegation has `requireApprovalAboveAmount` set and the charge
amount exceeds it (but still fits `perTransactionLimit`), `POST /payments/charge`
does **not** call a PSP. It reserves the spend (same reservation as
above — protects the monthly budget even while the charge sits
pending) and returns immediately:

```json
{
  "paymentId": "a1b2c3d4-...",
  "status": "PENDING_APPROVAL",
  "approvalId": "e5f6g7h8-...",
  "requiresAction": false,
  "usedFallback": false,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

No `Payment` row exists yet — `paymentId` is the id that *will* be used
once approved. `pspTransactionId`/`pspProvider` are absent; the PSP was
never called.

### `POST /charge-approvals/:id/approve`

Approves and **immediately executes** the deferred charge in the same
request — there's no further async step. Returns the real charge result,
same shape `POST /payments/charge` itself returns
(`status: 'SUCCEEDED'`/`'FAILED'`/`'REQUIRES_ACTION'`/etc., with
`pspTransactionId` if applicable).

- **Roles**: `MERCHANT` (own delegations only), `ADMIN`
- **Errors**: `403` belongs to a different merchant; `404` not found;
  `409` already approved or denied.

### `POST /charge-approvals/:id/deny`

Denies the charge and releases the reserved spend back to the
delegation — the PSP is never called.

- **Body**: `{ reason?: string }`
- **Roles**: `MERCHANT` (own delegations only), `ADMIN`
- **Errors**: `403` belongs to a different merchant; `404` not found;
  `409` already approved or denied.

### `GET /charge-approvals` / `GET /charge-approvals/:id`

List (optionally filtered by `delegationId`/`status`) or get a single
charge approval — same `MERCHANT`-self-scoped /
`ADMIN`/`OPERATOR`/`READONLY`-cross-merchant access model as
`GET /delegations`.

## Agent attribution on disputes (Phase 1)

Every charge made through a `Delegation` is tagged with that
delegation's id and `initiatedBy: 'agent'` on the underlying payment —
real, indexed columns (not a free-form metadata bag). If that charge is
later disputed, `GET /admin/disputes`/`GET /admin/disputes/:id` surface
the same `delegationId`/`initiatedBy`, snapshotted at the moment the
dispute was recorded. See
[`disputes.md`](../../business-domain/disputes.md#agentdispute-attribution-phase-1)
— this is audit-trail data capture only, not a liability determination.
