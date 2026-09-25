# SDK: Implementation

How `sdk/node` (`@deadislove/omniswitch-node`) is actually built — for *why* it
exists and what trade-off it accepts, see
[`../../adr/0005-first-party-node-sdk.md`](../../adr/0005-first-party-node-sdk.md).
For *how to use it*, see [`../../guide/sdk/`](../../guide/sdk/). This
document is the third leg: how the package itself is put together, so
someone extending it (a new wrapped endpoint, a second language) knows
where things live and why.

**Five more languages exist**: `sdk/java`, `sdk/dotnet`, `sdk/python`,
`sdk/rust`, `sdk/go` — same contract (signing, idempotency, webhook
verification, wrapped endpoints), each in its own ecosystem's idioms.
See [`../../adr/0006-multi-language-sdk-parity.md`](../../adr/0006-multi-language-sdk-parity.md)
for why, and each package's own `README.md` for its specifics — this
document's Node-specific detail below still applies to that package
only.

## Package layout

```
sdk/node/
  src/
    client.ts     — OmniSwitchClient: auth, request signing, the wrapped endpoints
    signing.ts     — signRequest(): the outbound HMAC computation
    webhooks.ts    — verifyWebhookSignature(): the inbound HMAC verification
    errors.ts      — OmniSwitchApiError, built from a non-2xx response body
    types.ts       — request/response shapes for the wrapped endpoints
    index.ts       — the package's public exports
  test/
    *.spec.ts      — unit tests, mocked fetch
  tsconfig.json    — build config (no jest types — this is what ships)
  tsconfig.test.json — extends tsconfig.json, adds jest types + test/ for ts-jest
  jest.config.js
  package.json
```

Kept as a self-contained package with its own `package.json`/
`tsconfig.json`/`jest.config.js` rather than folded into the main
application's own build — it has a different runtime target (a
published npm package eventually, not a deployed service) and a much
smaller dependency surface, and mixing the two build graphs would mean
every change to either one risks breaking the other's compile.

**The root `tsconfig.json` explicitly excludes `sdk`.** The one real
end-to-end test
([`../../../test/sdk-node-client.e2e-spec.ts`](../../../test/sdk-node-client.e2e-spec.ts))
imports directly from `sdk/node/src`, and TypeScript's module resolution
pulls in every file that import reaches — without the exclusion, `tsc`
and `nest build` (both scoped to `rootDir: "./src"`) fail outright on
`sdk/node/src/*.ts` being outside that root the moment anything in
`test/` imports it. Excluding `sdk` keeps the main application's own
build ignorant of the SDK's existence, while `ts-jest` (which compiles
whatever file Jest actually asks it to transform, independent of any
`tsc`-level `include`/`exclude`) still compiles and runs that e2e test
normally.

## HMAC request signing

`signRequest(secret, method, path, body)` in `signing.ts` computes:

```
HMAC-SHA256(secret, `${timestamp}.${method}.${path}.${body}`)
```

— byte-for-byte the same formula `HmacSignatureGuard` verifies server-side
(see [`../security-and-compliance.md`](../security-and-compliance.md)
and [`../../guide/api/README.md#hmac-request-signing`](../../guide/api/README.md#hmac-request-signing)).
Two details matter enough to call out explicitly:

- `path` must be the exact string the server sees as
  `request.originalUrl`, including the `/api/v1` prefix and any query
  string — not a normalized or relative version. `OmniSwitchClient`
  computes this internally; a caller never has to get this right by
  hand.
- `body` must be the *exact* string that gets sent on the wire.
  `OmniSwitchClient` signs the same `JSON.stringify()` output it then
  passes as the request body — never a value that's serialized once
  for signing and serialized again (potentially differently) for
  sending.

## Idempotency-key handling

Every signed call accepts an optional `idempotencyKey` in its second
argument. When omitted, `OmniSwitchClient` generates a fresh
`crypto.randomUUID()` per call. A caller that needs to retry a specific
logical operation (a network failure, a timeout — see
[`../../guide/api/README.md#idempotency`](../../guide/api/README.md#idempotency))
passes the *same* key explicitly on the retry; the client never
generates a second key for what the caller has told it is the same
operation.

## Auth and token lifecycle

`authenticate()` calls `POST /auth/token` lazily — on first use, not at
construction time — and caches the resulting JWT along with its
expiry. A cached token is reused until 30 seconds before its own
`expiresIn` elapses, at which point the next call transparently
re-authenticates first. If a request still comes back `401` despite a
token that looked unexpired (revocation, rotation, deactivation server-
side), `OmniSwitchClient` forces exactly one re-authentication and
retries the original request once — guarded by an internal `isRetry`
flag so a resource endpoint that keeps 401ing even against a freshly
issued token can't recurse without bound.

A merchant credential with MFA enabled gets a restricted, pending token
back from `POST /auth/token` (`mfaRequired: true`) — `authenticate()`
treats this as a hard failure (`OmniSwitchApiError` with code
`MFA_NOT_SUPPORTED`) rather than returning a token every subsequent
call would then fail against anyway. See ADR-0005 for why that's a
deliberate scope limit, not a gap.

## Webhook signature verification

`verifyWebhookSignature(secret, rawBody, signatureHeader, toleranceSeconds?)`
in `webhooks.ts` verifies the `X-OmniSwitch-Signature` header this
platform signs its own outbound notifications with — the exact
verify-side mirror of `signOmniSwitchPayload()` in
`src/shared/utils/notification-delivery.util.ts`:

```
t=<unix seconds>,v1=<hex HMAC-SHA256 of `${timestamp}.${rawBody}`>
```

Parses the header, checks the timestamp against a tolerance window
(default 300 seconds, overridable), and compares signatures with
`crypto.timingSafeEqual` — never a plain `===`, which would leak timing
information about how much of the signature matched. Returns `false`
for any failure mode (missing header, malformed header, expired
timestamp, mismatched signature) rather than throwing, so a caller can
gate a `401` response on a single falsy check without a `try`/`catch`.

## Testing strategy

Two layers, deliberately not just one:

1. **Unit tests** (`sdk/node/test/*.spec.ts`, run via `npm test` from
   `sdk/node/`) — a mocked `fetch` (injected through the client's own
   `fetch` constructor option) proves the client computes the right
   request shape, handles the auth/retry/error paths correctly, and
   that `signRequest()`/`verifyWebhookSignature()` produce/accept the
   right bytes in isolation. Fast, no external dependencies, but only
   proves the client agrees with itself about what "correct" looks
   like.
2. **One real end-to-end test**
   ([`../../../test/sdk-node-client.e2e-spec.ts`](../../../test/sdk-node-client.e2e-spec.ts),
   run via the main repository's own `npm run test:e2e`) — boots a real
   instance of this application (`createTestApp()`, the same helper
   every other e2e spec in this repository uses) and additionally calls
   `.listen(0)` to get a real ephemeral TCP port, then drives it through
   `OmniSwitchClient`'s real `fetch()` calls. This is the layer that
   actually proves the real, running `HmacSignatureGuard` and
   `IdempotencyInterceptor` accept what this client sends — a wrong
   byte in the signed payload, or a subtly incorrect header name, would
   pass every mocked unit test (which only checks the client's own
   internal consistency) and fail here.

## Building and consuming it today

```bash
cd sdk/node
npm install
npm run build   # emits dist/ (gitignored, matching the main app's own dist/)
npm test        # unit tests only — see above for the e2e layer
```

Published to this repository's own GitHub Packages npm registry
(`npm install @deadislove/omniswitch-node`, with a `.npmrc` pointing
`@deadislove` at `https://npm.pkg.github.com`) — see
[ADR-0007](../../adr/0007-github-packages-publishing.md) for why that's
GitHub Packages specifically, not the public npm registry. Building
from source as above is still how `sdk-package.yml`/`sdk-publish.yml`
themselves produce it, and how to work on the SDK itself.

## Extending it

Adding a new wrapped endpoint follows the same shape as the existing
five:

1. Add the request/response types to `types.ts`.
2. Add a method to `OmniSwitchClient` in `client.ts`, calling the
   private `request()` helper with `signed: true` if the endpoint
   requires HMAC (any endpoint documented as `+HMAC` in
   [`../../guide/api/README.md`](../../guide/api/README.md)).
3. Add a mocked-`fetch` unit test in `sdk/node/test/client.spec.ts`.
4. Add a real assertion to
   [`../../../test/sdk-node-client.e2e-spec.ts`](../../../test/sdk-node-client.e2e-spec.ts)
   exercising the new method against the real running app — the whole
   point of that file is that every wrapped endpoint gets proven
   against real guards, not just a mock.
