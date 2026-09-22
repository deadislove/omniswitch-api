# ADR-0005: A first-party Node/TypeScript client, not just a documented REST API

## Status

Accepted

## Context

Every integration against this API up to now has meant talking to the
REST surface directly — computing HMAC signatures by hand, managing
`Idempotency-Key` values across retries, and (for a merchant that wants
to receive outbound notifications) verifying `X-OmniSwitch-Signature`
on incoming webhooks. The REST API's own reference documentation
(`docs/guide/api/`) is accurate and complete, but accurate documentation
doesn't stop a real integrator from getting three specific, mechanical
things wrong:

- **Signing the wrong bytes.** `HmacSignatureGuard` verifies
  `HMAC-SHA256(secret, "${timestamp}.${method}.${path}.${rawBody}")`
  against the exact wire bytes it received. A hand-rolled integration
  that re-serializes a JSON object before signing it (instead of
  signing the exact string it's about to send) produces a signature
  that silently doesn't match for some payloads — key ordering, number
  formatting, and whitespace all change on a parse-then-restringify
  round trip.
- **Getting idempotency wrong under retry.** A network timeout or a
  5xx forces a caller to decide whether to retry — and whether to reuse
  the original `Idempotency-Key` or mint a new one. Reusing the wrong
  key skips a request that should have been distinct; generating a new
  key on every retry defeats the whole mechanism and risks a duplicate
  charge.
- **Skipping webhook verification entirely.** Computing an HMAC
  comparison correctly (constant-time, with a timestamp-drift check) is
  easy to get subtly wrong or skip outright under deadline pressure —
  and a receiver that doesn't verify at all will act on a forged
  request exactly as if it were real.

## Decision

Build a first-party Node/TypeScript client, `sdk/node` (package name
`@omniswitch/node`), living in this repository rather than a separate
one, covering the money-movement endpoints
(charge/refund/capture/cancel/get-payment) plus a standalone
`verifyWebhookSignature()` export a merchant's own webhook receiver can
call directly.

**No runtime HTTP dependency.** The client uses the platform-native
`fetch()` (available unconditionally on Node 18+, which this project's
own `engines` field already requires) instead of adding `axios` or
`node-fetch`. `fetch` is injectable via a constructor option
specifically so tests can substitute a mock without needing a real
network call.

**HMAC signing, idempotency-key generation, and token lifecycle are all
handled internally**, not left to the caller: `signRequest()` computes
the exact same signed-payload string `HmacSignatureGuard` verifies;
every signed call gets a fresh `crypto.randomUUID()` `Idempotency-Key`
unless the caller explicitly passes one to reuse across a retry;
`POST /auth/token` is called lazily on first use and the resulting JWT
is cached and refreshed shortly before its own expiry, with a single
forced re-authentication on an unexpected 401 (bounded to one retry, not
an unconditional loop).

**Scoped to merchant credentials in this first cut** — not an
agent-delegation credential (its own signing key, no `X-Merchant-Id`,
a different token-issuance endpoint). A merchant credential with MFA
enabled is explicitly rejected with a clear error rather than silently
returning a token that every subsequent call would then fail against;
MFA guards a human dashboard login, not a machine-to-machine credential
this client is built for.

**Verified two different ways, deliberately**: unit tests against a
mocked `fetch` prove the client computes the right request shape and
handles responses/errors correctly in isolation; a separate, genuine
end-to-end test (`test/sdk-node-client.e2e-spec.ts`) boots a real
instance of this application on a real TCP port and drives it through
the client's own real HTTP calls — proving the real
`HmacSignatureGuard`/`IdempotencyInterceptor` actually accept what this
client sends, not merely that the client and a hand-written assertion
agree with each other about what "correct" means.

## Consequences

**What this buys**: the three mistakes in the Context section above
become structurally unavailable to anyone using this client instead of
hand-rolling requests — there's no code path in which a caller can sign
the wrong bytes, mismanage an idempotency key, or skip webhook
verification, because the client does all three itself.

**What this costs**: a second surface that has to stay in sync with the
REST API. Today it wraps five endpoints; the rest of the API (
subscriptions, disputes, marketplace splits, every admin operation) has
no first-party client at all, and that gap has to stay honestly
documented rather than implied to be covered. Every future change to a
wrapped endpoint's contract now needs updating in two places, not one.

**Not published to any package registry.** This lives in the same
repository as the API it wraps and is built from source
(`cd sdk/node && npm install && npm run build`), not installable via
`npm install @omniswitch/node` from a public registry. Publishing it
is a distinct decision — it commits to public versioning, a support
lifecycle, and a compatibility contract independent of this
repository's own release cadence — and isn't made by this ADR.

**MFA-enabled credentials can't use this client.** A real, deliberate
constraint for the server-side integration use case this targets, not
an oversight — but worth stating plainly so it isn't discovered as a
surprise: rotate to (or create) an API credential without MFA enabled
for this kind of integration.

## Alternatives considered

- **Add `axios`/`node-fetch` as a dependency instead of using the
  platform's own `fetch()`**: rejected — Node 18+ already ships a
  spec-compliant global `fetch`; adding an HTTP client dependency for
  functionality the runtime already provides only adds a transitive
  dependency tree to audit and keep patched, for no functional gain.
- **Auto-generate a client from the OpenAPI schema already served at
  `/api/docs`**: would guarantee endpoint coverage tracks the API
  automatically, but a generated client is weakest exactly where this
  one needs to be strongest — HMAC signing, idempotency-key handling,
  and webhook verification are cross-cutting conventions no OpenAPI
  schema expresses, so a generated client would still need this same
  hand-written layer added on top. Worth revisiting once the number of
  wrapped endpoints grows enough that keeping a hand-written wrapper in
  sync becomes the harder half of the problem.
- **Ship request-signing as a small standalone library, leaving the
  rest of the HTTP call to the caller**: rejected — signing correctly
  in isolation still leaves idempotency-key lifecycle and
  authentication-token management as separate things an integrator has
  to get right on their own, splitting the "don't get this wrong"
  surface across multiple packages instead of closing it in one place.
