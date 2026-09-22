# @omniswitch/node

A Node/TypeScript client for the OmniSwitch payment gateway API. Handles
the three things an integrator most reliably gets wrong doing this by
hand:

- **HMAC request signing** (`X-Signature`/`X-Timestamp`/`X-Merchant-Id`)
  — computed for you on every charge/refund/capture/cancel call.
- **Idempotency-Key handling** — a fresh UUID v4 per call unless you
  pass one explicitly (to reuse across a retried logical operation).
- **Outbound webhook signature verification** — `verifyWebhookSignature()`
  checks the `X-OmniSwitch-Signature` header OmniSwitch signs its own
  notifications with (disputes, subscriptions, AML review, sanctions
  screening), so your webhook receiver doesn't have to implement that
  HMAC comparison itself.

Auth (`POST /auth/token`) is also handled transparently — the first
call obtains a JWT; later calls reuse it until shortly before its
1-hour expiry, then re-authenticate automatically.

This package lives in this repo (not published to npm) — see
[`docs/guide/api/README.md`](../../docs/guide/api/README.md) for the
full API this wraps. See also
[`docs/guide/sdk/`](../../docs/guide/sdk/) (usage guide),
[`docs/technical/sdk/`](../../docs/technical/sdk/) (how this package is
built), [`docs/business-domain/sdk/`](../../docs/business-domain/sdk/)
(why it exists), and
[`docs/adr/0005-first-party-node-sdk.md`](../../docs/adr/0005-first-party-node-sdk.md)
(the decision record).

## Install (within this repo)

```bash
cd sdk/node
npm install
npm run build
```

## Usage

```ts
import { OmniSwitchClient } from '@omniswitch/node';

const client = new OmniSwitchClient({
  baseUrl: 'https://api.example.com/api/v1',
  apiKeyId: process.env.OMNISWITCH_API_KEY_ID!,
  apiKeySecret: process.env.OMNISWITCH_API_KEY_SECRET!,
  hmacSecret: process.env.OMNISWITCH_HMAC_SECRET!,
  merchantId: 'merchant_acme_corp',
});

const charge = await client.charge({
  amount: 49.99,
  currency: 'USD',
  paymentMethodId: 'pm_...', // opaque, client-side-tokenized reference — never a raw card number
  orderId: 'order_12345',
});

if (charge.status === 'SUCCEEDED') {
  console.log(`Charged ${charge.paymentId} via ${charge.pspProvider}`);
}

// Later, a partial refund of the same charge:
await client.refund(charge.paymentId, { amount: 10, reason: 'requested_by_customer' });
```

### Idempotency across a retried operation

```ts
const idempotencyKey = crypto.randomUUID();
try {
  await client.charge(params, { idempotencyKey });
} catch (err) {
  // A network failure or timeout — safe to retry with the SAME key.
  // The server replays the original result instead of charging twice.
  await client.charge(params, { idempotencyKey });
}
```

### Verifying an outbound webhook

```ts
import { verifyWebhookSignature } from '@omniswitch/node';

app.post('/webhooks/omniswitch', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8'); // the exact bytes received — do not re-serialize
  const signatureHeader = req.header('X-OmniSwitch-Signature');

  if (!verifyWebhookSignature(process.env.OMNISWITCH_HMAC_SECRET!, rawBody, signatureHeader)) {
    return res.status(401).send('invalid signature');
  }

  const event = JSON.parse(rawBody);
  // handle event.event — e.g. 'dispute.created', 'sanctions_screening.flagged'
  res.status(200).end();
});
```

### Error handling

Every non-2xx response throws `OmniSwitchApiError`, exposing the same
stable `code` field the raw API returns (safe to branch on — `error`/
`message` are for logging, not string-matching):

```ts
import { OmniSwitchApiError } from '@omniswitch/node';

try {
  await client.charge(params);
} catch (err) {
  if (err instanceof OmniSwitchApiError && err.code === 'DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED') {
    // ...
  }
  throw err;
}
```

## What this doesn't cover yet

- **Agent/delegation credentials.** This client is merchant-credential-
  only — an `AGENT` token (its own delegation-issued signing key, no
  `X-Merchant-Id`) is a real, different auth shape this SDK doesn't
  wrap yet. See
  [`../../docs/guide/api/agentic-payments.md`](../../docs/guide/api/agentic-payments.md).
- **MFA.** If the merchant credential you authenticate with has MFA
  enabled, `authenticate()` throws `MFA_NOT_SUPPORTED` rather than
  attempting the interactive challenge flow — MFA guards the human
  dashboard login path, not a server-side integration credential.
- **Other endpoints.** Only charge/refund/capture/cancel/get-payment are
  wrapped so far — the rest of the API (subscriptions, disputes,
  marketplace splits, admin operations) is real but not yet covered by
  this client; see the REST API directly for those in the meantime.

## Testing

- `npm test` (from this directory) — unit tests for signing/webhook
  logic and client HTTP behavior against a mocked `fetch`.
- [`../../test/sdk-node-client.e2e-spec.ts`](../../test/sdk-node-client.e2e-spec.ts)
  — the real end-to-end proof, run via the main repo's own e2e suite
  (`npm run test:e2e` from the repo root): this client's requests
  against a really-running app instance, verified by the real
  `HmacSignatureGuard`/`IdempotencyInterceptor`, not a mock.
