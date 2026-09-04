# Contract Testing (Stripe / Adyen Sandbox)

`test/contract/` verifies `StripePSPAdapter`/`AdyenPSPAdapter` against
the **real** Stripe/Adyen test-mode APIs, not `scripts/mock-psp/server.js`.
The e2e suite (`test/*.e2e-spec.ts`) exercises real Postgres/Redis/Vault
but talks to mock-psp for the PSP leg — mock-psp is a hand-maintained
approximation of Stripe's/Adyen's request/response shapes, so it can only
catch drift the person who last updated it thought to encode. It cannot
catch Stripe/Adyen actually changing a field name, adding a
newly-required parameter, or deprecating an endpoint these adapters call.
That's what this suite is for.

**Status: framework only, never executed.** This repository has no
Stripe or Adyen sandbox credentials, so `test/contract/stripe.contract-spec.ts`
and `test/contract/adyen.contract-spec.ts` have not been run against the
real APIs. Both files are `describe.skip`ped unless their required
credential env var is set, so `npm test` / `npm run test:e2e` / CI never
touch them. Treat every assertion in these files as "this is what the
adapter's own code says the response should look like," not as something
independently confirmed against Stripe/Adyen — that confirmation only
happens the first time someone actually runs this with real credentials.

## Why real credentials, and why they aren't in CI

Contract tests exist to catch a real third party's API drifting out from
under this codebase's assumptions — that only works if they hit the real
API. They also create and settle (small, test-mode) real charges, so they
are meaningfully slower and less deterministic than the rest of this
project's test suite. Both properties argue against running them
unattended on every push: no CI workflow references
`test/jest-contract.json`, and the intended usage is a deliberate,
occasional run — e.g. after upgrading either PSP integration, or before
a release that touches `stripe-psp.adapter.ts`/`adyen-psp.adapter.ts` —
not a merge gate.

## Running the Stripe suite

1. Get a Stripe **test-mode** secret key (`sk_test_...`) from
   <https://dashboard.stripe.com/test/apikeys> on a Stripe account you
   control. Never use a live (`sk_live_...`) key here — the suite creates
   and captures real (test-mode) charges.
2. Start a local Redis for the circuit breaker to use (the adapter still
   goes through `RedisCircuitBreakerService`, same as production):
   `docker-compose up -d redis`.
3. Run:
   ```bash
   STRIPE_CONTRACT_TEST_SECRET_KEY=sk_test_xxx npm run test:contract -- stripe
   ```
   `stripe.contract-spec.ts` bridges `STRIPE_CONTRACT_TEST_SECRET_KEY`
   into the `STRIPE_SECRET_KEY` the adapter actually reads, so the
   e2e/local-dev placeholder value never leaks into a real API call and
   vice versa. It also refuses to run if the key doesn't start with
   `sk_test_`, as a guard against an accidental live-key run.
4. Optional: `STRIPE_CONTRACT_TEST_BASE_URL` to point at something other
   than `https://api.stripe.com/v1` (not normally needed).

**What it covers**: `charge()` (both `automatic` and `manual` capture),
a real decline (Stripe's `pm_card_chargeDeclined` test token), `capture()`,
`refund()`, `cancel()`, `verifyPaymentMethod()`, and
`fetchSettlementTransactions()`. Uses Stripe's own documented test-mode
PaymentMethod tokens (`pm_card_visa`, `pm_card_chargeDeclined`) — see
<https://docs.stripe.com/testing> — not anything specific to this repo.

## Running the Adyen suite

Adyen has no public well-known test token equivalent to Stripe's
`pm_card_visa` — a `storedPaymentMethodId` has to come from a real
tokenization against your own Adyen test merchant account first (Adyen's
Drop-in/Components test checkout, or a direct `/paymentMethods` call).
There is no way to run this suite without first completing that
one-time setup in the Adyen Customer Area sandbox.

1. Get, from an Adyen test merchant account you control: an API key, the
   merchant account name, and a `storedPaymentMethodId` (tokenize a
   test card through Adyen's test Drop-in, or via their API directly —
   see <https://docs.adyen.com/development-resources/testing/test-card-numbers/>).
2. `docker-compose up -d redis` (same reason as the Stripe suite).
3. Run:
   ```bash
   ADYEN_CONTRACT_TEST_API_KEY=xxx \
   ADYEN_CONTRACT_TEST_MERCHANT_ACCOUNT=YourTestMerchant \
   ADYEN_CONTRACT_TEST_STORED_PAYMENT_METHOD_ID=xxx \
   npm run test:contract -- adyen
   ```
   Same credential-bridging and test-environment-host guard as the
   Stripe suite (refuses to run unless the base URL looks like Adyen's
   `-test.adyen.com` host).
4. Optional: `ADYEN_CONTRACT_TEST_BASE_URL` to override the default
   `https://checkout-test.adyen.com/v71`.

**What it covers**: `charge()` (immediate and manual-capture), `capture()`,
`refund()` (Adyen refunds are asynchronous — the assertion is that the
request is accepted with `status: 'PENDING'`, not that funds have
settled), `cancel()`, `verifyPaymentMethod()` (a zero-value,
off-session authorization — see `AdyenPSPAdapter.verifyPaymentMethod()`'s
own docblock for why Adyen has no separate SetupIntent-style API), and
`fetchSettlementTransactions()`.

## How to accept the result

A clean run (`npm run test:contract` with both credential sets present)
means every assertion above passed against the real API on the day it
ran — treat it as a point-in-time confirmation, not a standing
guarantee; re-run after any change to either adapter or before a release
that touches PSP integration code. A failure here, with mock-psp-backed
e2e tests still green, is the specific signal this suite exists to
produce: the adapter's assumptions about Stripe's/Adyen's real API have
drifted, even though this repo's own mock of that API hasn't (yet) been
updated to match.

## What this doesn't cover

- **Webhooks** — `test/webhooks.e2e-spec.ts` already covers signature
  verification end-to-end against payloads this repo constructs itself;
  actually receiving a live webhook from Stripe/Adyen's real servers
  would need a publicly reachable endpoint (e.g. a tunnel), which is out
  of scope here.
- **3DS/SCA challenge flows** (`REQUIRES_ACTION`) — both suites use
  frictionless test tokens; a real challenge flow needs a browser to
  complete the redirect, which a Jest contract spec can't do.
- **Rate limits, timeouts, and other production-scale behavior** on
  Stripe's/Adyen's side — each suite makes only a handful of calls per
  run.
