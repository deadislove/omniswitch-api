# API Versioning & Deprecation Policy

## Current state

`main.ts` enables Nest's `VersioningType.URI` with `defaultVersion: '1'` —
every route resolves to `/api/v1/...` unless a controller/handler
explicitly declares a different `@Version(...)`. There is exactly one
version in production today; nothing has ever been deprecated. This
document is the policy for when that changes, plus the concrete
mechanism (`@Deprecated()`, below) that makes a deprecation a real,
machine-readable HTTP signal instead of only a line in a changelog.

## Introducing a new version

Nest's URI versioning supports an old and a new version of a route
coexisting in the same deployment — a controller (or a single handler
within one) can declare `@Version('2')` while the rest of the class
stays on the implicit default (`'1'`). Concretely, introducing `v2` of an
existing route means:

1. Add the new handler (same controller class or a new one) decorated
   with `@Version('2')`.
2. The `v1` handler keeps running, unmodified, serving existing callers.
3. Both are real, live routes — `v2` is not a "preview" behind a flag;
   once published, it's committed to the same stability expectations as
   `v1` was.

This is a breaking-change mechanism, not a general-purpose one — most
API evolution (new optional field, new endpoint) doesn't need a new
version at all. Reach for `v2` only when a change would break existing
callers if made in place (a field's meaning changes, a required
parameter is added, a response shape changes incompatibly).

## Deprecating a version or route

### The mechanism: `@Deprecated()`

```typescript
@Deprecated({
  sunsetDate: '2027-06-01',
  migrationGuideUrl: 'https://docs.example.com/migrate-to-v2-charge',
})
@Post()
charge(...) { ... }
```

`DeprecationHeaderInterceptor` (registered globally in `app.module.ts`,
`src/shared/interceptors/deprecation-header.interceptor.ts`) reads this
metadata on every request and adds three headers a well-behaved API
client can act on programmatically, not just a human reading a
changelog:

- `Deprecation: true` — [draft-ietf-httpapi-deprecation-header](https://www.ietf.org/archive/id/draft-ietf-httpapi-deprecation-header-latest.html),
  the same signal Stripe's and GitHub's own APIs send.
- `Sunset: <HTTP-date>` — [RFC 8594](https://www.rfc-editor.org/rfc/rfc8594),
  the date the route stops working.
- `Link: <url>; rel="deprecation"` — points at a real migration guide,
  not just "see the changelog."

Verified in `deprecation-header.interceptor.spec.ts`: headers are set
exactly on a route carrying `@Deprecated()` and absent on every other
route — a unit test, not an e2e one, since no real route in this
codebase is deprecated today and one shouldn't be added just to
exercise this mechanism.

### The SLA

| Step | Requirement |
|---|---|
| **Announce** | `@Deprecated()` added with a `sunsetDate` at least **6 months** out from the day it ships. Six months, not a shorter window, because this is a payment API — integrators often need their own change-management/compliance cycle before touching production payment code, not just a code change on their end. |
| **Migration guide** | `migrationGuideUrl` must resolve to a real, complete guide *before* `@Deprecated()` merges — not a placeholder to fill in later. A caller hitting the deprecated route should be able to follow that link and finish migrating without asking anyone a question. |
| **Monitor real usage** | `DeprecationHeaderInterceptor` logs a warning (`Deprecated route called: ...`) on every hit — see "What this doesn't do" below for why that's a log line and not yet a metric. Before the sunset date, confirm real traffic against the route has actually dropped to zero (or every remaining caller is a known, contacted exception) — a caller silently still depending on a "deprecated" route is a real payment-processing outage waiting to happen if it's removed on schedule regardless. |
| **Remove** | Only after the sunset date has passed *and* the usage check above is clean. Removing on schedule without checking real traffic defeats the purpose of having a monitoring step at all. |

### What this doesn't do

- **No traffic metric wired up yet** — the interceptor logs, it doesn't
  increment a Prometheus counter. `MetricsController` owns its own
  private `Registry` instance (see `docs/technical/architecture.md`);
  wiring a live, request-driven `Counter` into that same registry from a
  separate interceptor is a reasonable next step but wasn't built here
  since no route is deprecated yet to actually need it — build it when
  the first real deprecation happens, against that route specifically,
  rather than speculatively now.
- **No automated enforcement of the sunset date** — nothing currently
  stops a deprecated route from continuing to work past its `Sunset`
  header date. Removal is a deliberate code change (delete the handler),
  reviewed the same as any other change, not a runtime cutoff.
- **Doesn't cover backward-incompatible *behavior* changes within the
  same version** — this mechanism is specifically for a versioned route
  being retired in favor of a newer one. A behavior change within `v1`
  that isn't additive is a different problem (avoid it, or it's a `v2`
  change by definition) and isn't what `@Deprecated()` is for.
