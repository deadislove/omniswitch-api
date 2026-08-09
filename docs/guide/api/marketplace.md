# Marketplace API

Source: `payment.controller.ts`'s `splits` field (charge time),
`marketplace-payout-admin.controller.ts` (payouts), plus KYC submission
in [`merchants-and-auth.md`](./merchants-and-auth.md#post-adminmerchantsidkycsubmit).
Read
[`business-domain-guide.md`](../business-domain-guide.md#6-marketplace--split-payments)
first for the platform/connected-account model and the KYC/reserve gate
split.

---

## Splits (charge time)

There's no separate "create a split" endpoint — a split is a parameter
on `POST /payments/charge` (see [`payments.md`](./payments.md)):

```json
{
  "amount": 100,
  "currency": "USD",
  "paymentMethodId": "pm_...",
  "splits": [
    { "merchantId": "merchant_connected_seller", "amount": 25.0 }
  ]
}
```

Only usable by a `PLATFORM` merchant, only targeting its own `CONNECTED`
merchants, only with `captureMethod: 'automatic'` (a manual-capture
charge can't be split). Validated *before* the PSP is ever called:
unknown/non-connected recipient or a split total exceeding the net
payout both fail the whole request with no charge attempted. See
[`payments.md`](./payments.md#post-paymentscharge) for the exact error
codes.

---

## Payouts (`/admin/marketplace`)

A connected merchant's split proceeds don't move the instant they're
credited — they're batched into `Payout` records with a rolling reserve,
gated by KYC before they're actually transferable. All endpoints below:

- **Roles**: `ADMIN`, `OPERATOR`

### `GET /admin/marketplace/payouts`

List, optionally filtered by `merchantId`.

### `GET /admin/marketplace/payouts/:id`

- **Errors**: `404` not found.

**`PayoutSummaryDto` shape**:

```json
{
  "id": "a1b2c3d4-...",
  "merchantId": "merchant_connected_seller",
  "sweepRunId": "a1b2c3d4-...",
  "grossAmount": 68.5,
  "reserveAmount": 6.85,
  "netAmount": 61.65,
  "currency": "USD",
  "reserveStatus": "HELD",
  "releaseEligibleAt": "2026-04-01T00:00:00.000Z",
  "reserveReleasedAt": null,
  "kycBlocked": true,
  "kycClearedAt": null,
  "transferStatus": "NOT_INITIATED",
  "transferId": null,
  "transferInitiatedAt": null,
  "transferError": null,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

`kycBlocked` and `reserveStatus` are independent gates — a payout can be
`reserveStatus: "NONE"` (no reserve configured) and still `kycBlocked:
true`, or vice versa. Both must clear before a transfer can be
initiated.

### `POST /admin/marketplace/run-payouts`

Batches every `CONNECTED` merchant's unswept ledger balance into a
`Payout`, withholding each merchant's configured rolling reserve. Same
work the daily `@Cron` does.

**Response `200`**: `{ id, windowStart, windowEnd, connectedMerchantsPaid }`

### `POST /admin/marketplace/payouts/:id/release-reserve`

Manually releases one payout's reserve, bypassing `releaseEligibleAt`.

- **Errors**: `404` not found (`PAYOUT_NOT_FOUND`); `409` no reserve
  (`PAYOUT_HAS_NO_RESERVE`) or already released
  (`PAYOUT_RESERVE_ALREADY_RELEASED` — also returned if a concurrent
  release attempt wins the race).

### `POST /admin/marketplace/release-eligible-reserves`

Runs the reserve-release sweep now — releases every reserve whose
`releaseEligibleAt` has passed.

**Response `200`**: `{ released: number, failed: number }`

### `POST /admin/marketplace/recheck-kyc-blocks`

Runs the KYC-recheck sweep now — clears every `kycBlocked` payout whose
recipient has since become `VERIFIED` (including a payout created
*before* KYC was ever submitted).

**Response `200`**: `{ cleared: number }`

### `POST /admin/marketplace/payouts/:id/initiate-transfer`

Sends this payout's `netAmount` via the (mocked) bank rail
(`BankTransferPort`). Never covers a reserve released later — that
remains a known, documented gap (see the top-level README's Known
Limitations).

- **Errors**: `404` not found (`PAYOUT_NOT_FOUND`); `409` KYC-blocked
  (`PAYOUT_KYC_BLOCKED`), zero net amount
  (`PAYOUT_NO_TRANSFERABLE_AMOUNT`), or already initiated
  (`PAYOUT_TRANSFER_ALREADY_INITIATED` — also returned if a concurrent
  initiation attempt wins the race); `422` the bank declined the transfer
  (`PAYOUT_TRANSFER_FAILED`).

### `POST /admin/marketplace/initiate-eligible-transfers`

Runs the transfer-initiation sweep now — initiates a transfer for every
payout that isn't KYC-blocked, has a net amount, and hasn't already been
initiated (a previously `FAILED` transfer is retried).

**Response `200`**: `{ initiated: number, failed: number }`

---

## Related

- Onboarding a `CONNECTED` merchant and submitting its KYC application:
  [`merchants-and-auth.md`](./merchants-and-auth.md).
- Configuring a merchant's payout reserve rate/hold period
  (`PATCH /admin/merchants/:id/payout-reserve-policy`): same doc.
