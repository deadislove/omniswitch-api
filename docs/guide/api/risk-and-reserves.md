# Risk Tiering & Reserves API

Source: `reserve-admin.controller.ts`, `risk-tiering-admin.controller.ts`.
Read
[`business-domain-guide.md`](../business-domain-guide.md#7-merchant-risk-tiering--reserves)
first. This is the *per-charge* merchant reserve — distinct from the
marketplace payout reserve in [`marketplace.md`](./marketplace.md),
which applies at payout time instead.

- **Roles** (all endpoints below): `ADMIN`, `OPERATOR`

## Reserve holds (`/admin/reserves`)

### `GET /admin/reserves`

List, optionally filtered by `merchantId` and/or `status`
(`HELD`/`RELEASED`).

### `GET /admin/reserves/:id`

- **Errors**: `404` not found.

**`ReserveHoldSummaryDto` shape**: `{ id, paymentId, merchantId, amount, currency, status, releaseEligibleAt, createdAt, releasedAt? }`

### `POST /admin/reserves/:id/release`

Manually releases a hold, bypassing `releaseEligibleAt` — an operator
override (e.g. a merchant that's since proven low-risk).

- **Errors**: `404` not found; `409` already `RELEASED`.

### `POST /admin/reserves/release-eligible`

Runs the release sweep now instead of waiting for the daily schedule —
releases every `HELD` hold whose `releaseEligibleAt` has passed.

**Response `200`**: `{ released: number, failed: number }`

A hold's size/hold-period comes from `MerchantEntity.reserveBps`/
`reserveHoldDays`, configured via
`PATCH /admin/merchants/:id/reserve-policy` — see
[`merchants-and-auth.md`](./merchants-and-auth.md).

---

## Automatic risk tiering (`/admin/risk-tiering`)

### `POST /admin/risk-tiering/run`

Runs `RiskTieringService`'s sweep now instead of waiting for the daily
schedule. For every **auto-managed** merchant (`riskTierAutoManaged:
true` — the default, until an operator sets a reserve policy by hand),
recomputes the trailing lost-dispute rate and adjusts `reserveBps`/
`reserveHoldDays` accordingly, in both directions.

**Response `200`**:

```json
{ "evaluated": 12, "changed": 2, "skipped": 3 }
```

`skipped` covers merchants without enough settled-charge volume in the
trailing window to evaluate meaningfully, not an error state.

There's no endpoint to read a merchant's current tier directly — it's
just whatever `reserveBps`/`reserveHoldDays`/`riskTierAutoManaged`
currently are on the merchant record
(`GET /admin/merchants`, see [`merchants-and-auth.md`](./merchants-and-auth.md)).
A manual `PATCH .../reserve-policy` call automatically flips
`riskTierAutoManaged` to `false` so a hand-tuned reserve doesn't get
silently overwritten by the next sweep tick — re-enable via
`PATCH .../risk-tier-auto`.
