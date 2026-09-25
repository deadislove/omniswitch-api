# omniswitch-sdk-go

A Go client for the OmniSwitch payment gateway API — the Go sibling of
[`sdk/node`](../node/), covering the same surface and the same three
things an integrator most reliably gets wrong doing this by hand:

- **HMAC request signing** (`X-Signature`/`X-Timestamp`/`X-Merchant-Id`)
  — computed for you on every charge/refund/capture/cancel call.
- **Idempotency-Key handling** — a fresh UUID v4 per call unless you
  pass one explicitly (to reuse across a retried logical operation).
- **Outbound webhook signature verification** — `VerifyWebhookSignature()`
  checks the `X-OmniSwitch-Signature` header OmniSwitch signs its own
  notifications with.

Auth (`POST /auth/token`) is handled transparently — the first call
obtains a JWT; later calls reuse it until shortly before its expiry,
then re-authenticate automatically.

Not published as a real Go module anywhere — lives in this repo only,
same posture as `sdk/node`. The `module` path in `go.mod` is a
placeholder for local use, not a real importable location.

## Build (within this repo)

```bash
cd sdk/go
go test ./...   # unit tests, mocked HttpSender — no real network call
go build ./...
```

Entirely standard library — `net/http`, `encoding/json`, `crypto/hmac`,
`crypto/sha256`, `crypto/subtle`, `crypto/rand` (for UUID v4 generation,
implemented directly rather than pulling in `google/uuid` for one
function) — no external dependency at all.

## Usage

```go
import "github.com/omniswitch/omniswitch-sdk-go"

client, err := omniswitch.NewClient(omniswitch.ClientOptions{
    BaseURL:      "https://api.example.com/api/v1", // must be https://
    APIKeyID:     os.Getenv("OMNISWITCH_API_KEY_ID"),
    APIKeySecret: os.Getenv("OMNISWITCH_API_KEY_SECRET"),
    HmacSecret:   os.Getenv("OMNISWITCH_HMAC_SECRET"),
    MerchantID:   "merchant_acme_corp",
})
if err != nil {
    log.Fatal(err)
}

params := omniswitch.NewChargeParams(49.99, "USD")
params.PaymentMethodID = "pm_..." // opaque, client-side-tokenized reference — never a raw card number
params.OrderID = "order_12345"

charge, err := client.Charge(params, "")
if err != nil {
    log.Fatal(err)
}
if charge.Status == "SUCCEEDED" {
    fmt.Printf("Charged %s via %s\n", charge.PaymentID, charge.PspProvider)
}

// Later, a partial refund of the same charge:
amount := 10.0
client.Refund(charge.PaymentID, omniswitch.RefundParams{Amount: &amount, Reason: "requested_by_customer"}, "")
```

### Idempotency across a retried operation

```go
idempotencyKey := uuid() // any UUID v4 generator, or reuse your own request id
if _, err := client.Charge(params, idempotencyKey); err != nil {
    // A network failure or timeout — safe to retry with the SAME key.
    client.Charge(params, idempotencyKey)
}
```

### Verifying an outbound webhook

```go
rawBody := ... // the exact bytes received — do not re-serialize
signatureHeader := r.Header.Get("X-OmniSwitch-Signature")

if !omniswitch.VerifyWebhookSignature(hmacSecret, rawBody, signatureHeader) {
    http.Error(w, "invalid signature", http.StatusUnauthorized)
    return
}
```

### Error handling

Every non-2xx response returns a `*omniswitch.ApiError`, exposing the
same stable `Code` field the raw API returns:

```go
_, err := client.Charge(params, "")
var apiErr *omniswitch.ApiError
if errors.As(err, &apiErr) && apiErr.Code == "DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED" {
    // ...
}
```

## What this doesn't cover yet

Same scope limits as `sdk/node`: no agent/delegation credential support,
`MFA_NOT_SUPPORTED` rather than an interactive MFA challenge flow, and
only charge/refund/capture/cancel/get-payment are wrapped — the rest of
the API is real but not yet covered by this client.

**Testing depth vs. `sdk/node`**: this package has the same unit-test
coverage (signing/webhook logic, client HTTP behavior against a mocked
`HttpSender`), but does **not** yet have a `sdk/node`-style real
end-to-end test driving an actually-running instance of this application
— that layer exists only for the Node SDK today.
