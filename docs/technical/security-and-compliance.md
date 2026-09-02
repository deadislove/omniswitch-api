# Security & Compliance

This document covers two things that don't fit in the README: the design
trade-offs behind JWT revocation, and an honest assessment of where this
project stands relative to PCI DSS. Neither section is a substitute for a
real security audit or a formal PCI assessment — see
["If you take this to formal PCI DSS certification"](#if-you-take-this-to-formal-pci-dss-certification)
for what that actually requires.

---

## JWT Revocation

### The problem it solves

JWTs are stateless by design — verifying one is just a signature check, no
database round-trip required. That's the point of using them. But it also
means that, by default, **a token is valid until it naturally expires, full
stop**. Before this mechanism existed, deactivating a merchant in the admin
API didn't stop their already-issued token from working for up to another
hour (the access token lifetime). There was no way to log out, no way to
respond to a leaked token except waiting it out.

### Design

Two independent revocation lists, both stored in Redis, both checked on
every authenticated request in `JwtStrategy.validate()`:

| Mechanism | Key | Set by | Checked against |
|---|---|---|---|
| Single-token revocation | `revoked:jti:{jti}` | `POST /auth/token` issues a `jti` (UUID) per token; `POST /auth/revoke` blocklists it | The token's own `jti` claim |
| Merchant-wide revocation | `revoked-before:{merchantId}` | Merchant deactivation, API key rotation, `POST /admin/merchants/:id/revoke-sessions` | The token's `iat` (issued-at) claim |

The single-token list is for self-service logout. The merchant-wide list is
a coarse "anything issued before this timestamp is dead" cutoff — it's what
makes deactivation and credential rotation actually take effect immediately
instead of waiting out the token's remaining lifetime.

Both checks run in parallel (`Promise.all`) to avoid paying two sequential
Redis round-trips on every request.

### A second caller: agent delegation tokens

This mechanism has a second, later-added use beyond merchant sessions:
`POST /delegations` (see `docs/business-domain/future-directions.md#agentic-payments`)
issues a narrowly-scoped JWT (`roles: [UserRole.AGENT]`) an autonomous
agent authenticates with, carrying its own `jti` the same as any other
token. `POST /delegations/:id/revoke` calls the exact same
`TokenRevocationService.revokeToken()` `POST /auth/revoke` (logout)
already calls — no second revocation list, no agent-specific mechanism.
This is deliberate: a `Delegation` being revocable in real time is a
correctness requirement (a human needs to be able to cut off an
autonomous agent's purchasing authority immediately, not after up to an
hour of remaining token lifetime), and this codebase already had exactly
that property for merchant sessions. Everything in the "Trade-offs"
section below (Redis as a hard auth dependency, fail-closed on a Redis
outage, no durability guarantee beyond Redis's own persistence) applies
identically to an agent token — it is checked in the same
`JwtStrategy.validate()` call, not a separate code path.

An agent token is also covered by the *merchant-wide* revocation list
(`revoked-before:{merchantId}`), not just its own `jti` — `JwtStrategy.validate()`'s
`isMerchantTokenRevoked()` check runs unconditionally against any JWT's
`merchantId`/`iat` claims, and a delegation JWT carries the underlying
merchant's `merchantId` the same as a merchant's own login token does.
So deactivating a merchant, rotating its credentials, or an admin's
"log out everywhere" also invalidates every outstanding delegation it
had issued, with no delegation-specific handling needed — one
consequence of building `Delegation` tokens as ordinary JWTs sharing the
same claims shape and validation path, not a parallel credential system.
One real gap this does leave open: only the *token* is functionally
dead once a merchant is deactivated — the `Delegation` row's own
`status` column is untouched, so `GET /delegations/:id` would still
report `ACTIVE` for a delegation whose token can no longer actually
authenticate anything. Nothing reads that mismatch as broken today (the
token check is what actually gates every request), but it's a
misleading read for an operator relying on `status` alone.

### Trade-offs (read this before assuming this is production-ready as-is)

**Redis becomes a hard dependency for authentication, not just idempotency.**
Before this change, a Redis outage degraded idempotency guarantees and
caching. Now it also blocks every authenticated request, because
`JwtStrategy.validate()` can't determine revocation status without it. The
implementation fails *closed* (Redis unreachable → the revocation check
throws → auth fails) rather than *open* (Redis unreachable → assume nothing
is revoked → let the request through). Fail-closed is the safer default for
a payment API, but it does mean a Redis outage is now an availability
incident for the entire API, not just for payment-idempotency paths. If that
trade-off isn't acceptable, the usual fixes are a local in-memory cache of
revocation state with async refresh, or a circuit breaker that fails open
after N consecutive Redis errors — neither is implemented here.

**Revocation state can be lost if Redis loses data.** The revocation lists
live only in Redis, with no fallback store. If Redis restarts without AOF/RDB
persistence configured correctly (the local dev `docker-compose.yml` does
enable `appendonly yes`, but this is worth verifying explicitly in whatever
production Redis you point at), a previously-revoked token could become
valid again simply because the revocation record no longer exists — the
system has no way to distinguish "never revoked" from "revocation record
lost." This is the classic trade-off of a denylist backed by best-effort
storage rather than a durable one.

**Merchant-wide revocation is coarse, not per-session.** There's no concept
of "revoke session #3 but keep session #1 and #2 alive." Deactivation,
rotation, and "log out everywhere" all revoke *every* token issued before
the action, indiscriminately. That's the right behavior for the use cases
this was built for (compromise response, deactivation), but if you need
selective per-device/per-session revocation later, this data model doesn't
support it without adding a real session table.

**No revocation-list size bound beyond TTL.** Single-token entries expire
with the token's own remaining lifetime, so the list is naturally bounded by
`(active token count) × (max TTL)`. Merchant-wide markers are set to a 7-day
TTL regardless of the token's actual lifetime (1 hour) — this is deliberately
generous headroom in case the access-token lifetime is ever increased later,
at the cost of merchant-revocation keys outliving their usefulness by
several days in the current 1-hour-token setup. Neither is a real problem at
this scale, but worth knowing if Redis memory ever becomes a constraint.

### Alternatives that were considered and rejected

- **Allowlist instead of denylist** (only tokens explicitly marked "issued"
  are valid) — rejected because it requires a Redis write on every login
  *and* every validation, with no corresponding benefit over the denylist
  approach for this system's access patterns; a denylist keeps the common
  case (token not revoked) at the same cost while only growing with actual
  revocations.
- **Short-lived tokens + refresh tokens, no revocation list at all** — a
  legitimate alternative (many APIs use 5–15 minute access tokens precisely
  to make revocation-by-expiry acceptable). Not implemented here because it
  changes the client integration contract (silent refresh flow) more than
  this pass was scoped for; the 1-hour expiry plus this revocation mechanism
  gets equivalent security properties without that client-side complexity.
- **DB-backed sessions instead of stateless JWTs** — would fully solve
  revocation (and the Redis-durability problem above) by making the database
  the source of truth, but throws away the reason JWTs were chosen in the
  first place (no DB round-trip to verify a token, horizontally scalable
  auth with no shared session store). Worth reconsidering if the Redis
  coupling above turns out to be unacceptable.

---

## PCI DSS Compliance

**This is a scope-and-gap assessment based on reading the code, not a formal
PCI DSS assessment.** Only a QSA (Qualified Security Assessor) engagement or
a formally completed SAQ (Self-Assessment Questionnaire), backed by
quarterly ASV scans and annual penetration testing, can actually declare a
system PCI DSS compliant. Nothing below should be represented as compliance
to an auditor, an acquiring bank, or a customer.

### Scope: this system is designed to avoid touching cardholder data

The architecture never receives, processes, or stores a raw Primary Account
Number (PAN), expiry date, or CVV:

- `cardToken` / `paymentMethodId` (see `ChargePaymentDto`) are expected to be
  opaque references produced by **client-side tokenization** — Stripe.js /
  Stripe Elements, Adyen Web Components, or equivalent. The server never sees
  the actual card number; it forwards a token to the PSP.
- `PaymentEntity` has no column that stores a PAN. `psp_raw_response` stores
  whatever the PSP's API returned, which — because Stripe and Adyen never
  return full PANs in their own API responses — never contains one either.
- As of this pass, `IsNotRawCardNumber` (see `not-raw-card-number.validator.ts`)
  rejects any `cardToken` / `paymentMethodId` value that passes a Luhn check
  at PAN-length (12–19 digits), as a defense-in-depth backstop in case a
  client integration accidentally sends a real card number instead of a
  token. This is a safety net, not what makes the flow PCI-compliant — the
  tokenization itself is what does that.

This puts the *intended* integration model in the **SAQ A / SAQ A-EP**
family — the lightest PCI DSS self-assessment tiers, reserved for merchants
who fully outsource card data handling to a PCI-validated third party (here,
Stripe/Adyen) and never touch it themselves. Whether a specific deployment
lands on SAQ A vs. SAQ A-EP depends on how the *frontend* embeds the PSP's
tokenization (fully redirected/hosted fields vs. an iframe embedded in a
page you control) — that's a frontend decision this backend doesn't make for
you.

### What's already aligned with common PCI DSS v4.0 requirements

| Requirement (paraphrased) | Status |
|---|---|
| Req 3 — protect stored cardholder data | No PAN is stored, by design |
| Req 4 — encrypt transmission over public networks | TLS termination + HSTS enforced at the ingress (`k8s/ingress.yaml`) |
| Req 6 — secure development | Input validation (`class-validator`, whitelist mode), dependency audit performed, code review completed |
| Req 7 — restrict access by need-to-know | RBAC: `ADMIN` / `MERCHANT` / `OPERATOR` / `READONLY` / `AGENT` roles enforced by `RolesGuard` — `AGENT` is scoped further still, to exactly one route (`POST /payments/charge`) and its `Delegation`'s own `SpendPolicy`, see below |
| Req 8.2 — unique IDs for each user | Every merchant has its own API Key ID/Secret and JWT identity; no shared credentials |
| Req 8 — session/credential lifecycle | JWT revocation (this document, above), API key rotation, HMAC key rotation all implemented and take effect immediately |
| Req 10 — logging | Structured JSON logging (Winston) with correlation IDs on every request |
| Req 3.6 — cryptographic key management | `hmac_secret` is envelope-encrypted via Vault's Transit engine before it ever reaches Postgres — the app only ever has plaintext in memory, briefly, at creation/rotation/verification time. A DB compromise alone yields ciphertext, not usable keys. See [`secret-management.md`](./secret-management.md) for the design and — importantly — what this *doesn't* cover (dev-mode Vault is not production-ready as-is; `JWT_SECRET`/DB credentials/K8s-level secrets are still plain env vars). |
| Req 8.4.2 — multi-factor authentication | TOTP-based MFA: `POST /auth/mfa/enroll`/`confirm`/`verify`/`disable`, enforced at login once enabled — `JwtAuthGuard` rejects a post-login-but-pre-MFA token on every route except the verify step itself. Opt-in for `MERCHANT`/`OPERATOR`/`READONLY`; **mandatory for `ADMIN`** — `RolesGuard` rejects any request from an `ADMIN`-role caller whose merchant doesn't have `mfaEnabled`, on every route gated by `@Roles(...)`. Verified end to end in `test/mfa.e2e-spec.ts`. See the MFA section directly below for what this *doesn't* close. |
| Req 1 — network segmentation (defense-in-depth, not full CDE isolation) | `k8s/network-policy.yaml` default-denies all ingress/egress in the `payments` namespace, with explicit allows for the app's real traffic paths. Verified against a real `NetworkPolicy`-enforcing CNI via `scripts/network-policy-verify.sh`, not just reviewed by eye. See the section directly below for what this does and doesn't cover. |

### MFA — what's covered and what isn't

The mechanism (TOTP secret enrollment/confirmation, one-time backup codes,
an enforced-once-enabled login gate) is real, not a stub — see
`src/modules/merchant/mfa.service.ts` and `DEV_README.md`'s MFA entry for
the full design and verification. `RolesGuard` additionally requires it
for any caller whose token carries the `ADMIN` role: on every route
decorated with `@Roles(...)`, once normal role membership passes, a
caller holding `ADMIN` is looked up via `MerchantService` and rejected
(`403`, `MFA_REQUIRED_FOR_ADMIN`) unless `mfaEnabled` is `true` — even on
a route whose `@Roles(...)` also allows `OPERATOR`/`READONLY`, since the
check is keyed off the caller's own role, not the route's permitted set.
This closes the gap this section used to describe. What's still **not**
covered: this enforces MFA at the API layer only — it doesn't put the
admin surface behind a separate network-isolated bastion/VPN, and an
assessor may still want that as defense-in-depth beyond what a
request-time check provides.

One operational consequence worth knowing before enabling this in an
existing deployment: any `ADMIN`-role merchant created before this
enforcement existed (including the one `npm run seed:admin` creates) will
be locked out of every `@Roles(...)`-gated endpoint until it completes
`POST /auth/mfa/enroll` + `POST /auth/mfa/confirm` — those two routes
carry no `@Roles()` decorator, so they stay reachable specifically to
make that recovery possible without a database-level intervention.

### Network segmentation — defense-in-depth added, full CDE isolation intentionally out of scope

`k8s/network-policy.yaml` adds least-privilege pod-to-pod traffic
control to the `payments` namespace: it default-denies all ingress and
egress, then explicitly allows only the app's real traffic paths
(`omniswitch-api → pgbouncer → postgres`, `omniswitch-api → redis`,
`omniswitch-api → vault`, the ingress controller → `omniswitch-api`,
every batch job → `pgbouncer`, Prometheus → `omniswitch-api`'s
`:3000/metrics`). Before this, any pod in the namespace could reach any
other pod on any port, including the database/cache/secrets-store pods
holding merchant credentials and HMAC/TOTP secrets.

This is not full PCI DSS Requirement 1 CDE segmentation, and isn't
meant to be — see
["Scope: this system is designed to avoid touching cardholder data"](#scope-this-system-is-designed-to-avoid-touching-cardholder-data)
above. Client-side tokenization means this system never holds a raw
PAN, so there is no Cardholder Data Environment to isolate today; that
conclusion holds only as long as this architecture decision stands, and
would need revisiting if this system ever processes PANs directly.

Rules are checked bidirectionally by `scripts/network-policy-verify.sh`
against a real `NetworkPolicy`-enforcing CNI (a manifest reviewed by
eye alone cannot prove a rule is both sufficient — nothing legitimate
breaks — and effective — an unauthorized pod is actually refused):

- **Verified working**: `omniswitch-api → pgbouncer → postgres`,
  `omniswitch-api → redis`, `omniswitch-api → vault`, the
  `ingress-nginx → omniswitch-api` rule, a batch-job pod → `pgbouncer`,
  and Prometheus → `omniswitch-api`'s metrics port; a pod without the
  right label/namespace is refused on every one of these; `omniswitch-api`
  attempting to bypass pgbouncer and reach postgres directly is also
  correctly refused.
- **Not yet covered by this policy**: egress to the real Stripe/Adyen
  endpoints (`k8s/configmap.yaml` points at live PSP URLs) — harder
  than the rules above to express as a static policy, since Stripe/Adyen
  don't publish fixed IP ranges a plain `ipBlock` could pin; and egress
  for the deletion job to a cloud `BackupStorage` endpoint, when
  `DELETION_BACKUP_STORAGE` isn't `"local"` (the default, which needs no
  network egress at all).

### Gaps — what's missing before this could actually pass an assessment

| Requirement | Gap |
|---|---|
| ~~**Req 8.4.2 — mandatory MFA for admin access**~~ | **Closed** — `RolesGuard` rejects `ADMIN`-role callers without `mfaEnabled` on every `@Roles(...)`-gated route. Putting the admin surface behind a separate network-isolated bastion/VPN (defense-in-depth beyond the API-layer check) remains a separate, still-open hardening option. |
| **Req 10.5 — log integrity** | **Partially closed.** [`k8s/log-shipping-example.yaml`](../../k8s/log-shipping-example.yaml) shows a Fluent Bit DaemonSet tailing this app's structured JSON stdout (see `logger.config.ts`) and forwarding it off-node — illustrative only, not applied by any deploy path or verified against a real backend (this repo has no SIEM/Loki/Elasticsearch cluster to test against). Centralization is solved by that shape; *tamper-evidence* still depends entirely on the backend it's pointed at (object-lock/WORM storage, an append-only index) — nothing in this repo provides that property itself. The two local `logs/*.log` files `logger.config.ts` also writes are an unrelated, local-disk-only convenience (lost on pod restart, never shipped) — not this gap's answer either. |
| **Req 11.3 / 11.4 — vulnerability scanning & penetration testing** | PCI DSS requires quarterly scans by an **Approved Scanning Vendor (ASV)** and periodic penetration testing by a qualified third party. Nothing in this repository — including its own code review process — satisfies that requirement. It has to be procured separately, from a party that is not the system's own developer. |
| **Req 12 — governance** | [`docs/technical/incident-response.md`](./incident-response.md) covers the technical half — what each Prometheus alert means and which admin endpoint addresses it — but is not a substitute for a formal incident response plan, security policy documents, or a vendor management program for Stripe/Adyen/AWS/etc. Those remain organizational artifacts a codebase can't contain on its own. |

### If you take this to formal PCI DSS certification

Rough priority order, based on what blocks the least-effort path to a valid
SAQ:

1. **Nail down the frontend tokenization integration first.** Whether you
   land on SAQ A or SAQ A-EP is decided by how the card entry form is
   embedded, not by this backend. Confirm that before scoping anything else.
2. ~~Move `hmac_secret` out of a plain DB column.~~ **Done** — envelope-encrypted
   via Vault Transit, see [`secret-management.md`](./secret-management.md).
   Production still needs a real Vault deployment (not dev-mode) and a real
   auth method (not a static root token) before this satisfies an auditor —
   that doc is explicit about the gap between "the pattern is right" and
   "this specific deployment is production-ready."
3. ~~Add MFA to the admin API.~~ ~~Make it mandatory for `ADMIN`.~~ **Done** —
   TOTP enrollment, backup codes, an enforced login gate, and mandatory
   enforcement for any `ADMIN`-role caller all exist and work (see above).
   Putting the admin API behind a separate network-isolated bastion/VPN
   instead/in addition remains open, as further defense-in-depth.
4. ~~Stand up centralized logging.~~ **Shape done** —
   [`k8s/log-shipping-example.yaml`](../../k8s/log-shipping-example.yaml)
   (see above). Still open: pointing it at a real, tamper-evident backend
   and verifying the pipeline against one — this repo has none to test
   against — before relying on it for any compliance-relevant audit trail.
5. **Engage a QSA or complete the appropriate SAQ**, and budget for
   recurring ASV scans (quarterly) and penetration testing (at least
   annually) — these are ongoing obligations, not one-time setup work.
6. Everything else in the [Gaps](#gaps--whats-missing-before-this-could-actually-pass-an-assessment)
   table (governance documents, incident response plan, vendor management)
   can follow once the technical gaps above are closed — they're required
   for certification but don't block engineering work in the meantime.

The core architectural decision — tokenize on the client, never let raw card
data reach this backend — is the right one and is doing most of the real
work of keeping PCI scope small. Everything above is about closing the gap
between "architecturally out of scope" and "formally certified."
