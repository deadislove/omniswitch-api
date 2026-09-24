# ADR-0006: Multi-language SDK parity (Java, .NET, Python, Rust, Go)

## Status

Accepted

## Context

ADR-0005 deliberately scoped the first SDK to one language
(Node/TypeScript), on the reasoning that the hard design work — which
endpoints to wrap, the signing/idempotency/webhook-verification contract
— was the part worth getting right once before replicating it, and that
"the rest of the API... has no first-party client at all" was an honest,
acceptable gap for a first cut rather than something to close
immediately in every language at once.

That gap became worth closing once the same three integration mistakes
ADR-0005 identified (signing the wrong bytes, mismanaging idempotency
keys under retry, skipping webhook verification) needed to be
structurally prevented for integrators who don't work in Node — Java,
.NET, Python, Rust, and Go all being real, common server-side stacks for
a payment integration.

## Decision

Add five more clients — `sdk/java`, `sdk/dotnet`, `sdk/python`,
`sdk/rust`, `sdk/go` — each an independent, idiomatic implementation of
the exact same contract `sdk/node` already established, not a
line-by-line port:

- The same wrapped endpoints (charge/refund/capture/cancel/get-payment),
  the same `HMAC-SHA256(secret, "${timestamp}.${method}.${path}.${rawBody}")`
  signing formula, the same `Idempotency-Key` generate-unless-supplied
  behavior, the same transparent auth/token-refresh/401-retry-once
  lifecycle, and the same standalone webhook-signature-verification
  function.
- Each package uses its own ecosystem's idioms rather than mirroring
  Node's shape mechanically — a builder pattern in Java, `async`/`Task`
  in .NET, dataclasses in Python, a `Result`-returning API in Rust,
  explicit `(value, error)` returns in Go. Each also uses its own
  ecosystem's standard-library HTTP/JSON/crypto facilities wherever one
  exists (`java.net.http.HttpClient`+Jackson, `System.Net.Http`+
  `System.Text.Json`, `urllib.request`+`json`, `crypto/hmac`+`net/http`
  in Go), rather than defaulting to the heaviest common third-party
  choice — Rust is the one exception, since the standard library has no
  HTTP client at all; that package uses `ureq` (synchronous, minimal
  dependency surface) specifically to avoid forcing an async runtime
  choice on every caller.
- Every package is injectable at the HTTP-transport seam (an
  `HttpSender`/`IHttpSender`/`http_sender` interface or equivalent, the
  same role `fetch` plays for the Node client), so the exact same
  mocked-transport unit-test suite structure runs against all six
  languages: token caching/reuse, signed-header presence and shape,
  idempotency-key reuse, the 401-retry-once path, `OmniSwitchApiError`
  construction from a non-2xx body, and the `MFA_NOT_SUPPORTED` rejection.

## Consequences

**What this buys**: an integrator in any of these six languages gets the
same structural guarantee ADR-0005 established for Node — there's no
code path in which using the client lets you sign the wrong bytes,
mismanage an idempotency key, or skip webhook verification.

**What this costs, honestly**: six independent codebases now have to
stay in sync with the REST API's contract instead of one. A future
change to a wrapped endpoint's request/response shape is now six changes,
not one, and nothing currently enforces that they're made together —
this is a real maintenance surface, not a solved problem.

**Testing depth is not identical across all six.** Every package has the
same *shape* of mocked-transport unit test suite. Only `sdk/node` also
has a real end-to-end test (`test/sdk-node-client.e2e-spec.ts`) driving
an actually-running instance of this application over a real TCP
connection, proving the real `HmacSignatureGuard`/`IdempotencyInterceptor`
accept what the client sends rather than only proving the client agrees
with its own mocked assumptions. Extending that same real-server proof
to the other five languages is real future work this pass didn't do —
each would need its own harness capable of driving HTTP calls against
the Node application's real running process, which is a larger
undertaking than the unit-test parity achieved here.

**None of the six are published to a package registry** (npm, Maven
Central, NuGet, PyPI, crates.io, a Go module proxy) — all live in this
repository only, consistent with ADR-0005's own reasoning: publishing
commits to public versioning and a support lifecycle independent of this
repository's release cadence, and remains a distinct decision this ADR
doesn't make either.

## Alternatives considered

- **Auto-generate the other five from the Node SDK's TypeScript source
  or the OpenAPI schema**: rejected for the same reason ADR-0005
  rejected generating from OpenAPI in the first place — the part that
  actually needs to be correct (signing, idempotency, webhook
  verification) is cross-cutting logic no generator produces
  automatically; a generated skeleton would still need this same
  hand-written layer added per language, so generation would have saved
  relatively little of the actual work.
- **Wait until real integrator demand exists in a specific language
  before building that one**: a reasonable, more incremental
  alternative — rejected here in favor of closing the gap across all
  five common server-side ecosystems at once, on the same reasoning
  ADR-0005 used for choosing to build a client at all rather than
  relying on documentation alone.
- **One shared core (signing/webhook-verification logic) via FFI or a
  common native library, with thin per-language wrappers**: would remove
  the "six independent implementations of the same HMAC formula" risk
  this ADR's Consequences section flags — rejected for this first pass
  as materially more infrastructure (a build/distribution story for a
  native shared library across five runtimes) than six idiomatic,
  independently-testable implementations of a formula that's a few lines
  of code in every one of these languages. Worth revisiting if the
  formula itself ever needs to change and six simultaneous, correct
  edits prove to be the harder half of that problem.
