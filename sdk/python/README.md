# omniswitch-sdk (Python)

A Python client for the OmniSwitch payment gateway API — the Python
sibling of [`sdk/node`](../node/), covering the same surface and the
same three things an integrator most reliably gets wrong doing this by
hand:

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

Not published to PyPI — lives in this repo only, same posture as
`sdk/node`. Field names on request/response objects deliberately match
the wire JSON (camelCase) rather than translating to snake_case — see
`types.py`'s own module docstring for why.

## Install (within this repo)

```bash
cd sdk/python
python3 -m pip install -e .[test]
python3 -m pytest    # unit tests, mocked http_sender — no real network call
```

Requires Python 3.9+. Uses `urllib.request` (standard library) for HTTP
— no external runtime dependency.

## Usage

```python
import os
from omniswitch_sdk import OmniSwitchClient, OmniSwitchClientOptions, ChargeParams

client = OmniSwitchClient(OmniSwitchClientOptions(
    base_url="https://api.example.com/api/v1",
    api_key_id=os.environ["OMNISWITCH_API_KEY_ID"],
    api_key_secret=os.environ["OMNISWITCH_API_KEY_SECRET"],
    hmac_secret=os.environ["OMNISWITCH_HMAC_SECRET"],
    merchant_id="merchant_acme_corp",
))

charge = client.charge(ChargeParams(
    amount=49.99,
    currency="USD",
    paymentMethodId="pm_...",  # opaque, client-side-tokenized reference — never a raw card number
    orderId="order_12345",
))

if charge.status == "SUCCEEDED":
    print(f"Charged {charge.paymentId} via {charge.pspProvider}")

# Later, a partial refund of the same charge:
from omniswitch_sdk import RefundParams
client.refund(charge.paymentId, RefundParams(amount=10, reason="requested_by_customer"))
```

### Idempotency across a retried operation

```python
import uuid

idempotency_key = str(uuid.uuid4())
try:
    client.charge(params, idempotency_key=idempotency_key)
except Exception:
    # A network failure or timeout — safe to retry with the SAME key.
    client.charge(params, idempotency_key=idempotency_key)
```

### Verifying an outbound webhook

```python
from omniswitch_sdk import verify_webhook_signature

raw_body = ...  # the exact bytes received — do not re-serialize
signature_header = request.headers.get("X-OmniSwitch-Signature")

if not verify_webhook_signature(hmac_secret, raw_body, signature_header):
    return Response(status=401)
```

### Error handling

Every non-2xx response raises `OmniSwitchApiError`, exposing the same
stable `code` attribute the raw API returns:

```python
from omniswitch_sdk import OmniSwitchApiError

try:
    client.charge(params)
except OmniSwitchApiError as e:
    if e.code == "DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED":
        ...
    raise
```

## What this doesn't cover yet

Same scope limits as `sdk/node`: no agent/delegation credential support,
`MFA_NOT_SUPPORTED` rather than an interactive MFA challenge flow, and
only charge/refund/capture/cancel/get-payment are wrapped — the rest of
the API is real but not yet covered by this client.

**Testing depth vs. `sdk/node`**: this package has the same unit-test
coverage (signing/webhook logic, client HTTP behavior against a mocked
`http_sender`), but does **not** yet have a `sdk/node`-style real
end-to-end test driving an actually-running instance of this application
— that layer exists only for the Node SDK today.
