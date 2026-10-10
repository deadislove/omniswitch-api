# omniswitch-sdk (Rust)

A Rust client for the OmniSwitch payment gateway API — the Rust sibling
of [`sdk/node`](../node/), covering the same surface and the same three
things an integrator most reliably gets wrong doing this by hand:

- **HMAC request signing** (`X-Signature`/`X-Timestamp`/`X-Merchant-Id`)
  — computed for you on every charge/refund/capture/cancel call.
- **Idempotency-Key handling** — a fresh UUID v4 per call unless you
  pass one explicitly (to reuse across a retried logical operation).
- **Outbound webhook signature verification** — `verify_webhook_signature()`
  checks the `X-OmniSwitch-Signature` header OmniSwitch signs its own
  notifications with.

Auth (`POST /auth/token`) is handled transparently — the first call
obtains a JWT; later calls reuse it until shortly before its expiry,
then re-authenticate automatically.

Not published to crates.io — lives in this repo only, same posture as
`sdk/node`.

## Build (within this repo)

```bash
cd sdk/rust
cargo test     # unit tests, mocked HttpSender — no real network call
cargo build --release
```

Uses [`ureq`](https://crates.io/crates/ureq) — a synchronous HTTP
client, deliberately not `reqwest`/`tokio` — so this crate doesn't force
a particular async runtime on callers. `serde`/`serde_json` handle
(de)serialization; `hmac`/`sha2`/`subtle` handle signing and
constant-time comparison.

## Usage

```rust
use omniswitch_sdk::{OmniSwitchClient, OmniSwitchClientOptions, ChargeParams};

let client = OmniSwitchClient::new(OmniSwitchClientOptions::new(
    "https://api.example.com/api/v1",
    std::env::var("OMNISWITCH_API_KEY_ID").unwrap(),
    std::env::var("OMNISWITCH_API_KEY_SECRET").unwrap(),
    std::env::var("OMNISWITCH_HMAC_SECRET").unwrap(),
    "merchant_acme_corp",
));

let mut params = ChargeParams::new(49.99, "USD");
params.payment_method_id = Some("pm_...".to_string()); // opaque, client-side-tokenized reference — never a raw card number
params.order_id = Some("order_12345".to_string());

let charge = client.charge(&params, None)?;
if charge.status == "SUCCEEDED" {
    println!("Charged {} via {:?}", charge.payment_id, charge.psp_provider);
}

// Later, a partial refund of the same charge:
use omniswitch_sdk::RefundParams;
client.refund(&charge.payment_id, Some(&RefundParams::new(Some(10.0), Some("requested_by_customer".to_string()))), None)?;
```

### Idempotency across a retried operation

```rust
let idempotency_key = uuid::Uuid::new_v4().to_string();
match client.charge(&params, Some(&idempotency_key)) {
    Ok(charge) => { /* ... */ }
    Err(_) => {
        // A network failure or timeout — safe to retry with the SAME key.
        client.charge(&params, Some(&idempotency_key))?;
    }
}
```

### Verifying an outbound webhook

```rust
use omniswitch_sdk::verify_webhook_signature;

let raw_body: &str = ...; // the exact bytes received — do not re-serialize
let signature_header: Option<&str> = ...;

if !verify_webhook_signature(&hmac_secret, raw_body, signature_header) {
    // respond 401
}
```

### Error handling

Every non-2xx response returns `Err(Box<dyn Error>)` wrapping an
`OmniSwitchApiError`, exposing the same stable `code` field the raw API
returns:

```rust
use omniswitch_sdk::OmniSwitchApiError;

match client.charge(&params, None) {
    Err(e) => {
        if let Some(api_err) = e.downcast_ref::<OmniSwitchApiError>() {
            if api_err.code.as_deref() == Some("DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED") {
                // ...
            }
        }
    }
    Ok(_) => {}
}
```

## What this doesn't cover yet

Same scope limits as `sdk/node`: no agent/delegation credential support,
`MFA_NOT_SUPPORTED` rather than an interactive MFA challenge flow, and
only charge/refund/capture/cancel/get-payment are wrapped — the rest of
the API is real but not yet covered by this client.

**Testing depth vs. `sdk/node`**: this crate has the same unit-test
coverage (signing/webhook logic, client HTTP behavior against a mocked
`HttpSender`), but does **not** yet have a `sdk/node`-style real
end-to-end test driving an actually-running instance of this application
— that layer exists only for the Node SDK today.
