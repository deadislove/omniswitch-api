# Client SDKs

A Node/TypeScript client, `sdk/node` (`@deadislove/omniswitch-node`), wraps the
raw REST API described in [`../api/README.md`](../api/README.md) so an
integrator doesn't have to hand-compute HMAC signatures, manage
`Idempotency-Key` values, or implement webhook signature verification
themselves. See [`../../adr/0005-first-party-node-sdk.md`](../../adr/0005-first-party-node-sdk.md)
for why this exists, and
[`../../technical/sdk/`](../../technical/sdk/) for how it's actually
implemented. This page is the practical "how do I use it" reference.

Five more languages are also covered, each with the same contract in
its own idioms: `sdk/java`, `sdk/dotnet`, `sdk/python`, `sdk/rust`,
`sdk/go` — see [`../../adr/0006-multi-language-sdk-parity.md`](../../adr/0006-multi-language-sdk-parity.md)
and each package's own `README.md` for usage in that language. The rest
of this page uses Node in its examples; the same operations and
behavior apply across all six.

## When to use it vs. the raw REST API

Use the client for anything it covers (charge, refund, capture, cancel,
fetch a payment, verify an inbound webhook) — it removes an entire
class of integration bugs (wrong signature bytes, mismanaged retries,
unverified webhooks) that are otherwise easy to get wrong under
deadline pressure. For anything it doesn't cover yet (subscriptions,
disputes, marketplace splits, delegations, any admin operation), call
the REST API directly per [`../api/README.md`](../api/README.md) — the
client is a convenience layer over a subset of the API, not a
replacement for the API itself.

## Install

```bash
npm install @deadislove/omniswitch-node
```

Published to this repository's own GitHub Packages npm registry, not
the public npm registry — see the package's own
[`README.md`](../../../sdk/node/README.md) and
[ADR-0007](../../adr/0007-github-packages-publishing.md) for why only
here. Or, within this repository, straight from source:

```bash
cd sdk/node
npm install
npm run build
```

## Quick start

```ts
import { OmniSwitchClient } from '@deadislove/omniswitch-node';

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
```

`apiKeyId`/`apiKeySecret` come from `POST /admin/merchants` (or a
rotation call); `hmacSecret` is the merchant's HMAC signing key from the
same response. Authentication (`POST /auth/token`) happens
automatically on first use — there's no separate login step.

## Retrying safely

Reuse the same `idempotencyKey` across a retry of the *same* logical
operation — never generate a new one for a retry, and never reuse one
across two genuinely different charges:

```ts
import { randomUUID } from 'crypto';

const idempotencyKey = randomUUID();
try {
  await client.charge(params, { idempotencyKey });
} catch (err) {
  // A network failure or timeout — safe to retry with the SAME key.
  // The server replays the original result instead of charging twice.
  await client.charge(params, { idempotencyKey });
}
```

If you don't pass `idempotencyKey`, the client generates a fresh one
per call — correct for a normal, non-retried call, but not what you
want across a manual retry loop.

## Refunds, captures, and cancellation

```ts
// Partial refund of an existing charge
await client.refund(charge.paymentId, { amount: 10, reason: 'requested_by_customer' });

// A manual-capture authorization, captured later
const authorized = await client.charge({ ...params, captureMethod: 'manual' });
await client.capture(authorized.paymentId, { amount: 25 });

// ...or cancelled before capture
await client.cancel(authorized.paymentId);
```

## Verifying an outbound webhook

This platform signs its own outbound notifications (disputes,
subscriptions, AML review, sanctions screening) with
`X-OmniSwitch-Signature`, keyed by the same HMAC secret used for
outbound request signing. Verify it before trusting the payload:

```ts
import { verifyWebhookSignature } from '@deadislove/omniswitch-node';

app.post('/webhooks/omniswitch', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8'); // the exact bytes received — never re-serialize before verifying
  const signatureHeader = req.header('X-OmniSwitch-Signature');

  if (!verifyWebhookSignature(process.env.OMNISWITCH_HMAC_SECRET!, rawBody, signatureHeader)) {
    return res.status(401).send('invalid signature');
  }

  const event = JSON.parse(rawBody);
  // handle event.event — e.g. 'dispute.created', 'sanctions_screening.flagged'
  res.status(200).end();
});
```

`verifyWebhookSignature()` never throws — it returns `false` for every
failure mode (missing header, expired timestamp, mismatched signature),
so gating a `401` on it is always a single `if`.

## Handling errors

Every non-2xx response throws `OmniSwitchApiError`, carrying the same
stable, machine-readable `code` field the raw API returns (see
[`../api/README.md#error-format`](../api/README.md#error-format)) —
safe to branch on, unlike the human-readable `error`/`message` text:

```ts
import { OmniSwitchApiError } from '@deadislove/omniswitch-node';

try {
  await client.charge(params);
} catch (err) {
  if (err instanceof OmniSwitchApiError && err.code === 'DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED') {
    // handle the specific case
  }
  throw err;
}
```

## What this doesn't cover yet

- **Agent/delegation credentials.** The client is merchant-credential-
  only — an `AGENT` token (its own delegation-issued signing key, no
  `X-Merchant-Id`) is a real, different auth shape not wrapped yet. See
  [`../api/agentic-payments.md`](../api/agentic-payments.md) and call
  the REST API directly for that flow today.
- **MFA-enabled credentials.** If the credential you authenticate with
  has MFA enabled, `authenticate()` throws a clear
  `MFA_NOT_SUPPORTED` error rather than attempting an interactive
  challenge — use a credential without MFA enabled for a server-side
  integration like this.
- **Everything else in the API.** Subscriptions, plans, disputes,
  marketplace splits, delegations, and every admin operation are real
  endpoints with no first-party client coverage yet — call them
  directly per [`../api/README.md`](../api/README.md).
