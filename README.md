# OmniSwitch Payment Gateway API

[![CI](https://github.com/deadislove/omniswitch-api/actions/workflows/ci.yml/badge.svg)](https://github.com/deadislove/omniswitch-api/actions/workflows/ci.yml)
[![Security Scan](https://github.com/deadislove/omniswitch-api/actions/workflows/security-scan.yml/badge.svg)](https://github.com/deadislove/omniswitch-api/actions/workflows/security-scan.yml)
[![Chaos Drill](https://github.com/deadislove/omniswitch-api/actions/workflows/chaos-drill.yml/badge.svg)](https://github.com/deadislove/omniswitch-api/actions/workflows/chaos-drill.yml)

> Enterprise-grade, high-reliability Payment Gateway API Service built with **NestJS (TypeScript)**, following **Modular Monolith + Hexagonal Architecture (Ports & Adapters)** and **Domain-Driven Design (DDD)**.

A payment gateway sits between a merchant and the card networks — the
layer that routes a charge to whichever payment processor (PSP) makes
sense, books the accounting, and absorbs the money-movement edge cases
(refunds, disputes, retries, payouts) instead of leaving them to the
business. OmniSwitch is a from-scratch reference implementation of that
layer, covering more than a single "charge a card" endpoint: smart
multi-PSP routing (Stripe + Adyen, BIN-aware), a real double-entry
ledger, subscriptions with decline-aware dunning, marketplace splits
with connected-account payouts, dispute/chargeback handling, merchant
risk-based reserves, and delegated "agentic payment" credentials — see
[Key Features](#key-features) below for the full list.

This is a **portfolio/reference project**, built to show how these
pieces fit together end-to-end — including real, verified
infrastructure (Postgres replication, Redis, Vault), not just
mocked-out unit tests — rather than a production payment system. See
[Known Limitations](#known-limitations) and [`LICENSE`](./LICENSE)
before assuming any part of it is production-ready.

---

## 🏗️ Architecture Overview

```
omniswitch-api/
├── src/
│   ├── modules/
│   │   └── payment/
│   │       ├── domain/                    # Pure business logic (zero external deps)
│   │       │   ├── aggregates/            # PaymentAggregate, LedgerOutboxAggregate
│   │       │   ├── value-objects/         # Money, Currency, BinInfo, PaymentStatus
│   │       │   ├── events/                # Domain Events (PaymentCharged, etc.)
│   │       │   └── services/              # SmartRoutingStrategy
│   │       ├── ports/
│   │       │   └── outbound/              # Interfaces: PaymentRepositoryPort, PSPAdapterPort, CachePort
│   │       ├── adapters/
│   │       │   ├── persistence/           # TypeORM entities, mappers, repositories
│   │       │   ├── cache/                 # Redis adapter (ioredis)
│   │       │   └── psp/                   # Stripe, Adyen adapters + PaymentProcessorFactory
│   │       └── application/
│   │           ├── controllers/           # PaymentController (v1)
│   │           ├── sagas/                 # PaymentCheckoutSaga (compensating transactions)
│   │           ├── services/              # AcquirerRoutingService
│   │           ├── interceptors/          # IdempotencyInterceptor
│   │           └── dto/                   # ChargePaymentDto
│   ├── shared/
│   │   ├── auth/                          # JwtStrategy
│   │   ├── guards/                        # JwtAuthGuard, RolesGuard, HmacSignatureGuard
│   │   ├── decorators/                    # @Public(), @Roles()
│   │   ├── middleware/                    # CorrelationIdMiddleware
│   │   └── logging/                       # Winston structured logger
│   ├── health/                            # Health check controller
│   ├── app.module.ts
│   └── main.ts
├── k8s/                                   # Kubernetes manifests
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── hpa.yaml
│   ├── ingress.yaml
│   ├── configmap.yaml
│   └── secret.yaml
├── scripts/postgres/                      # DB initialization SQL
├── docs/                                  # Architecture, security/compliance,
│   ├── technical/                         # business-domain documentation —
│   └── business-domain/                   # see docs/README.md
├── Dockerfile                             # Multi-stage production build
├── docker-compose.yml                     # Local dev stack
└── .env.example                           # Environment template (copy to .env.local)
```

---

## 🚀 Key Features

### Architecture & Design Patterns
| Pattern | Implementation |
|---------|---------------|
| **Hexagonal Architecture** | Domain → Ports → Adapters layering |
| **Factory Pattern** | `PaymentProcessorFactory` for multi-PSP routing |
| **Repository Pattern** | `PaymentTypeOrmRepository` with Master/Replica |
| **Saga Pattern** | `PaymentCheckoutSaga` with compensating transactions |
| **Outbox Pattern** | Atomic payment + ledger event in single DB transaction |

### Security
- **JWT Authentication** (`@nestjs/passport` + `passport-jwt`) with **Redis-backed revocation** — logout, credential rotation, and merchant deactivation all invalidate outstanding tokens immediately instead of waiting out the token's natural expiry (see [`docs/technical/security-and-compliance.md`](docs/technical/security-and-compliance.md))
- **MFA (TOTP)**: opt-in second factor per merchant (`POST /auth/mfa/enroll`/`confirm`/`verify`/`disable`) — once enabled, login returns a short-lived restricted token that `JwtAuthGuard` rejects everywhere except the verify step, until a valid TOTP/backup code trades it for a full session
- **RBAC** (Role-Based Access Control: ADMIN, MERCHANT, OPERATOR, READONLY)
- **HMAC-SHA256** Request Signature Verification (replay attack prevention), per-merchant keys stored in the database and rotatable without a redeploy
- **Idempotency** via Redis distributed lock (`SETNX` with TTL)
- **Rate Limiting**: IP-scoped globally, plus a second per-merchant quota so multiple tenants sharing an IP don't share a limit — counters are Redis-backed (`RedisThrottlerStorage`), shared across every replica rather than per-pod
- Card references (`cardToken`/`paymentMethodId`) are validated to reject anything that looks like a raw card number — see the PCI DSS notes below

### Business Domain
- **Money Value Object**: ISO-4217 multi-currency, zero-decimal (JPY), 2-decimal (USD), 3-decimal (KWD)
- **Smart Routing Engine**: BIN country + amount + PSP health → optimal acquirer selection
- **SCA/3DS2 Risk Assessment**: Risk score → Frictionless or Challenge flow
- **Circuit Breaker**: Per-PSP failure tracking with OPEN/HALF_OPEN/CLOSED states, Redis-backed (`RedisCircuitBreakerService`) so every replica shares one view of each PSP's health instead of each pod deciding independently
- **Reconciliation**: Hourly (plus on-demand) diff of this system's ledger against each PSP's own settlement report — catches ledger/outbox bugs that unit/e2e tests structurally can't (see [`docs/technical/reconciliation.md`](docs/technical/reconciliation.md))
- **Per-merchant fee rate, with optional volume-based tiers**: Platform fee is a configurable basis-points rate per merchant (`MerchantEntity.platformFeeBps`, default 150 = 1.5%), not a single hardcoded percentage — set at onboarding or changed via `PATCH /admin/merchants/:id/fee-rate`. Optionally superseded by an ascending `feeTiers` schedule (`PATCH /admin/merchants/:id/fee-tiers`) that steps the rate down once this merchant's trailing current-month `SUCCEEDED` volume, in the currency being charged, reaches a threshold — priced off volume *before* the charge being resolved, so the charge that crosses a threshold still bills at the old rate. See [`docs/business-domain/fee-model.md`](docs/business-domain/fee-model.md), which also covers PSP interchange cost reconciliation (a separate number from this one)
- **FX conversion (settlement currency)**: A merchant can be paid out in a currency different from whatever currency a charge was made in (`MerchantEntity.settlementCurrency`) — converted via a real `FXRateProviderPort` at charge/capture time, booked as two correctly double-entry-balanced ledger legs, not just a value-object-level capability nothing called. Refunds and lost disputes replay the *same* charge-time rate rather than booking against the merchant in the charge currency regardless of what they actually received, so they net cleanly against the original payout. See [`docs/business-domain/fx-conversion.md`](docs/business-domain/fx-conversion.md)
- **Presentment currency**: `POST /payments/charge` accepts an optional `presentmentCurrency` and returns a computed display amount for the customer's statement — purely informational, doesn't touch what's actually charged/settled/booked. See [`docs/business-domain/fx-conversion.md#presentment-currency`](docs/business-domain/fx-conversion.md#presentment-currency)
- **Dispute/chargeback handling**: A dispute is tracked as its own record with a lifecycle (`NEEDS_RESPONSE` → `UNDER_REVIEW` → `WON`/`LOST`) and a response deadline, not just a payment status flip — representment (submitting evidence) actually calls the PSP; resolution (won/lost) arrives by webhook and, on a loss, books a ledger entry the same way a refund does. See [`docs/business-domain/disputes.md`](docs/business-domain/disputes.md)
- **Dispute auto-decision policy**: Every new dispute is automatically classified `ACCEPT`/`CONTEST`/`MANUAL_REVIEW` by amount and reason code — `CONTEST` immediately auto-submits templated evidence to the PSP for real; every dispute carries reason-code-specific evidence guidance either way. Creation/resolution emit structured events, not just log lines. See [`docs/business-domain/disputes.md#the-auto-decision-policy`](docs/business-domain/disputes.md#the-auto-decision-policy)
- **Merchant risk tiering & reserves**: A configurable per-merchant reserve (`MerchantEntity.reserveBps`/`reserveHoldDays`) withholds a slice of each charge's net amount into its own `ReserveHold` record instead of paying it out immediately, released either by a daily sweep or an operator's manual override — see [`docs/business-domain/risk-and-fraud.md`](docs/business-domain/risk-and-fraud.md#risk-tiering-chargeback-driven-reserves) for the business policy and [`docs/business-domain/ledger-and-settlement.md#merchant-risk-tiering--reserves`](docs/business-domain/ledger-and-settlement.md#merchant-risk-tiering--reserves) for the ledger mechanics
- **Recurring billing / subscriptions**: A `Subscription` produces its own real `Payment` every billing period by reusing `PaymentCheckoutSaga` wholesale — same smart routing, ledger booking, and FX/reserve handling a one-time charge gets — with decline-code-aware dunning (a hard decline like `stolen_card` cancels immediately, a retryable one like `insufficient_funds` uses a real day 1/3/7 backoff, not a flat retry-every-tick policy), real `subscription.past_due`/`subscription.canceled` event emission carrying the decline code, a real payment-method verification before a trial ever starts (`PSPAdapterPort.verifyPaymentMethod()` — Stripe's real SetupIntent primitive, a zero-value authorization for Adyen), and crash-recovery via a deterministic per-period payment id, not a distributed transaction. See [`docs/business-domain/subscriptions.md`](docs/business-domain/subscriptions.md) for the state machine and what's deliberately simplified (an illustrative, uncalibrated hard-decline code set)
- **Subscription plan catalog & proration**: A merchant-scoped `Plan` catalog (`POST /plans`) lets a subscription reference a reusable price instead of carrying its own amount, and `POST /subscriptions/:id/change-plan` prorates the remaining part of the current period through the same `PaymentCheckoutSaga` every other charge uses — upgrades charge the difference immediately (and the plan switch and the charge succeed or fail together), downgrades issue a credit applied against a future period's charge instead of a refund now. See [`docs/business-domain/subscriptions.md#plans-and-proration`](docs/business-domain/subscriptions.md#plans-and-proration)
- **Automatic risk-tier adjustment**: `RiskTieringService` recomputes each merchant's trailing lost-dispute rate on a daily sweep and adjusts its reserve policy accordingly — in both directions, with a manual-override escape hatch (`MerchantEntity.riskTierAutoManaged`) so an operator's hand-tuned reserve doesn't get silently clobbered. Deliberately simple, illustrative thresholds, not a calibrated underwriting model — see [`docs/business-domain/ledger-and-settlement.md`](docs/business-domain/ledger-and-settlement.md#automatic-risk-tier-adjustment)
- **Marketplace splits**: A `PLATFORM` merchant can onboard `CONNECTED` merchants under it (`MerchantEntity.accountType`/`platformMerchantId`) and route part of a charge's net proceeds directly to them via `POST /payments/charge`'s `splits` — each split is its own `MERCHANT` ledger credit, validated (recipient ownership, split total vs. net payout) before the PSP is ever called so an invalid split can't leave a charged-but-unbooked payment behind. A refund or lost dispute reverses each recipient's share proportionally, not just the platform's own account. See [`docs/business-domain/marketplace-and-payouts.md#marketplace-splits`](docs/business-domain/marketplace-and-payouts.md#marketplace-splits) for the mechanism
- **Marketplace payout scheduling, KYC, and transfer initiation**: A connected merchant's split proceeds are batched into scheduled `Payout` records (`POST /admin/marketplace/run-payouts`, daily `@Cron`) instead of being available the instant they're credited, withholding a configurable rolling reserve released later on its own schedule. A real (mocked) KYC review (`POST /admin/merchants/:id/kyc/submit`) gates whether a payout can actually be transferred — mirroring Stripe Connect's `charges_enabled`/`payouts_enabled` split, not whether the connected account can receive splits at all — and a verified payout's net amount can be sent via a real (mocked) bank transfer (`POST /admin/marketplace/payouts/:id/initiate-transfer`). See [`docs/business-domain/marketplace-and-payouts.md#payout-kyc-gating-and-real-transfer-initiation`](docs/business-domain/marketplace-and-payouts.md#payout-kyc-gating-and-real-transfer-initiation)
- **Agentic payments**: A merchant can authorize an autonomous agent via `POST /delegations`, returning a narrowly-scoped JWT (`AGENT` role, accepted on exactly one route, `POST /payments/charge`) bound to a real `SpendPolicy` (per-transaction limit, rolling monthly limit, optional category allowlist) — enforced by an atomic, race-safe reservation *before* the checkout saga ever calls a PSP, released again if that charge goes on to actually decline. `POST /delegations/:id/revoke` reuses the existing JWT revocation mechanism, so it takes effect immediately, not just once the token naturally expires. See [`docs/business-domain/future-directions.md#agentic-payments`](docs/business-domain/future-directions.md#agentic-payments)

### Observability
- **OpenAPI/Swagger** (`/api/docs`): every controller documents its success response type and the non-2xx cases it actually throws (404/409/422 etc.), not just request bodies — see [`DEV_README.md`](DEV_README.md#openapiswagger-completeness-pass---resolved) for the audit that closed this
- **Structured JSON Logging** (Winston) with Correlation IDs
- **Health Checks** (`/health`, `/health/live`, `/health/ready`) for K8s probes
- **Prometheus Metrics** (`/metrics`) — process metrics plus PSP circuit breaker state/success rate/latency, ledger outbox backlog, payment volume by status/provider (`omniswitch_payments_total`), and the latest reconciliation run's mismatch count per provider, all pull-computed at scrape time from existing state rather than in-process counters that would drift across replicas or reset on restart
- **Alerting**: `docker-compose up -d prometheus alertmanager` runs a real Prometheus evaluating [`monitoring/alert.rules.yml`](monitoring/alert.rules.yml) against the metrics above (circuit breaker OPEN, outbox dead-letters/backlog, low PSP success rate, reconciliation mismatches), with results visible in Alertmanager at `:9093` — see [`docs/technical/incident-response.md`](docs/technical/incident-response.md) for what each alert means and how to respond
- **Scheduled Chaos Drills**: a monthly (and on-demand) GitHub Actions run stops real containers (PSP, Redis, Postgres primary) against a fresh disposable stack to prove the resilience mechanisms above still hold, not just once during development — see [`docs/technical/tests/chaos-testing.md`](docs/technical/tests/chaos-testing.md)
- **SSE Streaming** for real-time payment status updates
- **Bulk Upload** CSV streaming via `multipart/form-data`

---

## 🛠️ Quick Start

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- npm

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start infrastructure (PostgreSQL + Redis + Mock PSP + Vault)
docker-compose up -d postgres-master postgres-replica pgbouncer-master pgbouncer-replica redis mock-psp vault

# 3. Copy and configure environment
cp .env.example .env.local
# Edit .env.local with your own JWT_SECRET/HMAC_SECRET (32+ random chars) and PSP test keys.
# The app refuses to start with a missing or short JWT_SECRET/HMAC_SECRET.

# 4. Run database migrations (schema is not auto-created — see
#    docs/technical/database-migrations.md)
npm run migration:run

# 5. Start the API in dev mode
npm run start:dev

# 6. Bootstrap the first ADMIN merchant (one-time; only needed once per
#    database — POST /admin/merchants itself requires an admin JWT, so this
#    is how you get the first one). Prints an apiKeyId/apiKeySecret/hmacSecret
#    once — save them, they're not shown again.
npm run seed:admin

# 6a. Log in with those credentials, then POST /auth/mfa/enroll and
#     /auth/mfa/confirm with that token before calling any other admin
#     endpoint — RolesGuard requires MFA for every ADMIN-role caller (see
#     Security Notes #8 below). Both routes work without MFA already
#     enabled, specifically so this step is always reachable.

# 7. Open Swagger docs
open http://localhost:3000/api/docs
```

### Full Stack with Docker Compose

```bash
# Start all services
docker-compose up -d

# With dev tools (pgAdmin + Redis Commander)
docker-compose --profile dev-tools up -d

# View logs
docker-compose logs -f api

# Stop all
docker-compose down
```

---

## 📡 API Endpoints

Every real route this system exposes — 92 in total, grouped by domain
area. This table is generated by reading the controllers directly (every
`@Get`/`@Post`/`@Patch`/`@Delete`/`@Sse` decorator), not maintained by
hand separately — if it and the code ever disagree, the code is right. For
full request/response schemas, error codes, and the reasoning behind
each endpoint's design, see [`docs/guide/api/`](docs/guide/api/) — this
table is the index, not the full reference.

**Auth key**: `Public` = no token; `JWT` = any authenticated role; a
role list means only those roles; `+HMAC` means the three
`X-Signature`/`X-Timestamp`/`X-Merchant-Id` headers are also required
(an `AGENT` token signs with its delegation's own signing key instead
of the merchant's — see
[`docs/guide/api/README.md#hmac-request-signing`](docs/guide/api/README.md#hmac-request-signing)).

### Auth ([`merchants-and-auth.md`](docs/guide/api/merchants-and-auth.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/auth/token` | Exchange an API Key ID + Secret for a JWT (or a short-lived pending token if MFA is enabled) | Public |
| `POST` | `/api/v1/auth/revoke` | Revoke the current token (logout) — takes effect immediately | JWT |
| `POST` | `/api/v1/auth/mfa/enroll` | Start MFA enrollment (generates a TOTP secret, not yet enforced) | JWT |
| `POST` | `/api/v1/auth/mfa/confirm` | Confirm enrollment with a TOTP code — enables MFA, returns one-time backup codes | JWT |
| `POST` | `/api/v1/auth/mfa/verify` | Trade a pending MFA token for a full one | JWT (mfaPending) |
| `POST` | `/api/v1/auth/mfa/disable` | Disable MFA — requires a valid TOTP/backup code | JWT |

### Merchants (admin) ([`merchants-and-auth.md`](docs/guide/api/merchants-and-auth.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/merchants` | List merchants (no secrets) | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants` | Onboard a new merchant — returns the API key secret once | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/rotate-api-key` | Rotate a merchant's API key secret | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/rotate-hmac-secret` | Rotate a merchant's HMAC signing key | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/status` | Activate/deactivate a merchant (deactivating revokes all sessions) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/fee-rate` | Change a merchant's platform fee rate (bps) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/fee-tiers` | Set/clear a merchant's volume-based fee schedule | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/settlement-currency` | Change a merchant's settlement currency | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/mcc-code` | Set a merchant's Merchant Category Code (drives industryRiskCategory) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/reserve-policy` | Change a merchant's reserve rate/hold period (disables auto risk-tiering) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/payout-reserve-policy` | Change a connected merchant's marketplace payout rolling-reserve policy | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/risk-tier-auto` | Enable/disable automatic risk-tier reserve management | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/psp-entitlement` | Set which PSPs this merchant's charges may route through | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/kyc/submit` | Submit/re-submit a connected merchant's KYC application | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/dispute-notification-channel` | Change which channel (EMAIL/SLACK/WEBHOOK) a merchant's dispute notifications go out on | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/subscription-notification-channel` | Change which channel (EMAIL/SLACK/WEBHOOK) a merchant's subscription.past_due/subscription.canceled notifications go out on | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/aml-review-notification-channel` | Change which channel (EMAIL/SLACK/WEBHOOK) a merchant's AML-review-flag notifications go out on | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:merchantId/aml-review` | Manually flag or clear a merchant's AML-review observation status (disables auto-management) | JWT (ADMIN/OPERATOR) |
| `PATCH` | `/api/v1/admin/merchants/:merchantId/aml-review-auto` | Re-enable automatic AML-review flag management for a merchant | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/merchants/:id/revoke-sessions` | Invalidate every token currently issued to this merchant | JWT (ADMIN) |

### Payments ([`payments.md`](docs/guide/api/payments.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/payments/charge` | Charge a payment with smart PSP routing — also usable by an AGENT token, checked against its delegation's spend policy | JWT/AGENT + HMAC (AGENT signs with its delegation's own signing key) |
| `GET` | `/api/v1/payments/:id` | Get payment details by id | JWT |
| `GET` | `/api/v1/payments/:id/status/stream` | SSE stream for real-time payment status updates | JWT |
| `POST` | `/api/v1/payments/:id/refund` | Refund a payment (full or partial) | JWT + HMAC |
| `POST` | `/api/v1/payments/:id/capture` | Capture a previously authorized (`REQUIRES_CAPTURE`) payment | JWT + HMAC |
| `POST` | `/api/v1/payments/:id/cancel` | Cancel a payment before capture | JWT + HMAC |
| `POST` | `/api/v1/payments/bulk-upload` | Bulk invoice upload (CSV, `multipart/form-data`) for batch processing | JWT |
| `GET` | `/api/v1/payments/routing/health` | PSP routing/circuit-breaker health status | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/payments/routing/circuit-breaker/:provider/reset` | Force a PSP's circuit breaker back to CLOSED | JWT (ADMIN/OPERATOR) |

### Ambiguous payments (risk & recovery) ([`risk-and-reserves.md`](docs/guide/api/risk-and-reserves.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/payments/ambiguous` | List `AMBIGUOUS` payments (a PSP call that got no response at all) | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/payments/ambiguous/run-auto-resolution` | Trigger the automated PSP-query resolution sweep on demand | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/payments/:id/resolve-ambiguous` | Manually resolve an `AMBIGUOUS` payment after checking the PSP directly | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/payments/:id/legal-hold` | Place a legal hold — excludes a payment from archiving/deletion | JWT (ADMIN/OPERATOR) |
| `DELETE` | `/api/v1/admin/payments/:id/legal-hold` | Release a legal hold | JWT (ADMIN/OPERATOR) |

### Subscriptions & Plans ([`subscriptions-and-plans.md`](docs/guide/api/subscriptions-and-plans.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/subscriptions` | Create a subscription (from a `Plan` or a direct amount/interval) — charges the first period immediately unless `trialDays` is set | JWT + HMAC |
| `GET` | `/api/v1/subscriptions/:id` | Get a subscription by id | JWT |
| `GET` | `/api/v1/subscriptions` | List subscriptions (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/subscriptions/:id/cancel` | Cancel a subscription — immediately, or at period end | JWT + HMAC |
| `POST` | `/api/v1/subscriptions/:id/change-plan` | Switch to a different plan — prorates the difference immediately (upgrade) or issues a credit (downgrade) | JWT + HMAC |
| `POST` | `/api/v1/admin/subscriptions/run-billing` | Run the billing sweep now instead of waiting for the daily schedule | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/plans` | Create a reusable subscription plan | JWT |
| `GET` | `/api/v1/plans/:id` | Get a plan by id | JWT |
| `GET` | `/api/v1/plans` | List plans (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/plans/:id/deactivate` | Deactivate a plan — existing subscribers are unaffected | JWT |

### Agentic Payments ([`agentic-payments.md`](docs/guide/api/agentic-payments.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/delegations` | Authorize a new agent within a spend policy — returns the agent's JWT once | JWT (MERCHANT/ADMIN) |
| `GET` | `/api/v1/delegations/:id` | Get a delegation by id | JWT |
| `GET` | `/api/v1/delegations` | List delegations (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/delegations/:id/revoke` | Revoke a delegation — the agent's JWT is rejected on its very next request | JWT (MERCHANT/ADMIN) |
| `GET` | `/api/v1/charge-approvals/:id` | Get a charge approval by id (a charge held pending human approval — `requireApprovalAboveAmount`) | JWT |
| `GET` | `/api/v1/charge-approvals` | List charge approvals (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/charge-approvals/:id/approve` | Approve a pending charge approval — executes the deferred charge in the same request | JWT (MERCHANT/ADMIN) |
| `POST` | `/api/v1/charge-approvals/:id/deny` | Deny a pending charge approval — releases the reserved spend, the PSP is never called | JWT (MERCHANT/ADMIN) |

### Disputes ([`disputes.md`](docs/guide/api/disputes.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/disputes` | List disputes, filterable by merchant/status | JWT (ADMIN/OPERATOR) |
| `GET` | `/api/v1/admin/disputes/:id` | Get a single dispute by id | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/disputes/:id/evidence` | Submit evidence to contest a dispute (representment) — calls the PSP | JWT (ADMIN/OPERATOR) |

### Risk & Reserves ([`risk-and-reserves.md`](docs/guide/api/risk-and-reserves.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/reserves` | List reserve holds, filterable by merchant/status | JWT (ADMIN/OPERATOR) |
| `GET` | `/api/v1/admin/reserves/:id` | Get a single reserve hold by id | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/reserves/:id/release` | Manually release a hold, bypassing `releaseEligibleAt` | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/reserves/release-eligible` | Run the reserve-release sweep now | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/risk-tiering/run` | Run the risk-tiering sweep now instead of waiting for the daily schedule | JWT (ADMIN/OPERATOR) |
| `PATCH` | `/api/v1/admin/merchants/:id/ambiguous-risk` | Manually flag/clear a merchant's ambiguous-risk status (reason required, audited) | JWT (ADMIN/OPERATOR) |
| `PATCH` | `/api/v1/admin/merchants/:id/ambiguous-risk-auto` | Re-enable automatic ambiguous-risk flag/auto-clear for a merchant | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/merchants/ambiguous-risk/run-auto-clear` | Run the ambiguous-risk auto-clear sweep now | JWT (ADMIN/OPERATOR) |

### Marketplace & Payouts ([`marketplace.md`](docs/guide/api/marketplace.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/marketplace/payouts` | List payouts, filterable by connected merchant | JWT (ADMIN/OPERATOR) |
| `GET` | `/api/v1/admin/marketplace/payouts/:id` | Get a single payout by id | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/run-payouts` | Run the payout sweep now — batches unswept connected-merchant balances into `Payout`s | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/payouts/:id/release-reserve` | Manually release a payout's rolling reserve | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/release-eligible-reserves` | Run the payout reserve-release sweep now | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/recheck-kyc-blocks` | Clear every KYC-blocked payout whose recipient is now `VERIFIED` | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/payouts/:id/initiate-transfer` | Initiate a bank transfer for a payout's net amount (mock/ACH/wire, via `BANK_TRANSFER_PROVIDER`) | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/initiate-eligible-transfers` | Run the transfer-initiation sweep now | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/payouts/:id/initiate-reserve-transfer` | Initiate a follow-up bank transfer for a payout's *released* reserve, independent of its net-amount transfer | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/initiate-eligible-reserve-transfers` | Run the reserve-transfer-initiation sweep now | JWT (ADMIN/OPERATOR) |

### Reconciliation ([`platform-ops.md`](docs/guide/api/platform-ops.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/reconciliation/runs` | List recent reconciliation runs | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/reconciliation/run` | Trigger an on-demand reconciliation run (defaults to the last hour) | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/psp-cost-reconciliation/run` | Compare estimated vs. actual-invoiced PSP processing fees for a window | JWT (ADMIN/OPERATOR) |

### Ledger Outbox ([`platform-ops.md`](docs/guide/api/platform-ops.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/outbox/failed` | List dead-lettered (`FAILED`) ledger outbox events | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/outbox/:id/retry` | Reset a `FAILED` event back to `PENDING` for the relay to retry | JWT (ADMIN/OPERATOR) |

### Webhooks ([`webhooks.md`](docs/guide/api/webhooks.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/webhooks/stripe` | Stripe webhook receiver | Signature (`Stripe-Signature`) |
| `POST` | `/api/v1/webhooks/adyen` | Adyen webhook receiver | Signature (HMAC in payload) |
| `POST` | `/api/v1/webhooks/bank-transfer` | ACH/wire rail settlement confirmation | Signature (`X-Bank-Transfer-Signature`) |
| `POST` | `/api/v1/webhooks/kyc` | KYC provider review-decision callback | Signature (`X-KYC-Signature`) |

### Observability

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health` | Comprehensive health check (readiness probe) | Public |
| `GET` | `/health/live` | Liveness probe | Public |
| `GET` | `/health/ready` | Readiness probe | Public |
| `GET` | `/metrics` | Prometheus metrics | Public |

### Charge Payment Request

```bash
curl -X POST https://api.omniswitch.io/api/v1/payments/charge \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "X-Signature: <HMAC_SHA256_SIGNATURE>" \
  -H "X-Timestamp: <UNIX_TIMESTAMP>" \
  -H "X-Merchant-Id: merchant_001" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 99.99,
    "currency": "USD",
    "paymentMethodId": "pm_card_visa",
    "orderId": "order_abc123",
    "description": "Premium subscription",
    "binInfo": {
      "bin": "424242",
      "country": "US",
      "cardBrand": "VISA",
      "cardType": "CREDIT"
    }
  }'
```

---

## 🧪 Testing

```bash
# Unit tests (mocked dependencies)
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:cov

# Run saga tests specifically
npm test -- payment.saga.spec.ts

# End-to-end tests (real app + real Postgres/Redis + mock-psp, no mocks)
docker-compose up -d postgres-master postgres-replica pgbouncer-master pgbouncer-replica redis mock-psp vault
npm run test:e2e
```

### Test Coverage
- `payment.saga.spec.ts`: Compensating transactions, PSP timeout, 3DS flow, Money VO, Domain Events
- `test/*.e2e-spec.ts` (338 tests across 43 spec files, real infra, no mocks): HMAC/webhook signature verification, the full charge → capture/refund/cancel lifecycle including multi-partial-capture accounting, per-merchant fee rate booking including volume-based fee tiers (threshold-crossing timing, per-currency scoping, clearing back to the flat rate), payment-volume Prometheus metrics reflecting real charges/declines, FX settlement-currency conversion including refunds/lost disputes replaying the original rate and presentment-currency display, merchant reserve holds (booking, manual release, the scheduled release sweep), automatic risk-tier adjustment (escalation, taper-down, manual-override), recurring billing (immediate/trial creation with real PSP payment-method verification, the billing sweep's renewal and crash-recovery paths, decline-code-aware dunning — a day 1/3/7 backoff for a retryable decline vs. immediate cancellation for a hard one, both with real event emission — cancel-at-period-end), a subscription plan catalog and mid-cycle change-plan proration (upgrade charges, downgrade credit issuance and consumption against a later period, cross-currency/non-ACTIVE rejection), marketplace splits (connected-account onboarding validation, charge-time split ledger entries verified directly against the database, invalid-split/manual-capture/settlement-currency rejection, proportional refund/lost-dispute reversal including a 3DS-then-webhook regression case), payout scheduling (rolling-reserve withholding, sweep-cursor correctness across repeated runs, reserve-release eligibility), and payout KYC gating/real transfer initiation (KYC-blocked payouts, verified-merchant transfer success and double-initiation rejection, bank-decline handling), agentic-payment delegation (spend-policy limit/category/currency rejection, atomic monthly-limit reservation across repeated charges, immediate revocation, PSP-decline reservation release, narrow-scope role rejection), dispute creation/representment/resolution (Stripe and Adyen) plus the auto-decision policy (accept/contest/manual-review, structured event emission), MFA enrollment/login-gate/backup-codes/disable, API prefix/versioning behavior, ledger booking timing (incl. a regression test for a double-booking bug found during development), the outbox relay, JWT revocation (logout, rotation, deactivation, admin "log out everywhere"), and per-merchant rate-limit isolation. This suite is what replaced the manual verification this project was originally validated with — see [`docs/technical/architecture.md#testing`](docs/technical/architecture.md#testing) for why it deliberately doesn't mock anything.

---

## 🐳 Docker

```bash
# Build production image
docker build --target production -t omniswitch/payment-gateway:1.0.0 .

# Check image size (target < 150MB)
docker images omniswitch/payment-gateway
```

---

## ☸️ Kubernetes Deployment

```bash
# Create namespace
kubectl create namespace payments

# Apply all manifests
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml      # Replace with real secrets first!
kubectl apply -f k8s/pgbouncer.yaml   # Must exist before `api` starts — configmap.yaml points DB_MASTER_HOST/DB_REPLICA_HOST at these Services
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/hpa.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/archiving-cronjob.yaml             # Data retention — see docs/compliance/data-retention.md
kubectl apply -f k8s/deletion-cronjob.yaml              # (also creates its own PVC for the pre-deletion backup file)
kubectl apply -f k8s/partition-maintenance-cronjob.yaml # Keeps upcoming-month partitions pre-created

# One-time, not part of the steady-state rollout above — apply once the
# cutover verification window has elapsed (see data-retention.md):
#   kubectl apply -f k8s/drop-cutover-tables-job.yaml

# Check rollout
kubectl rollout status deployment/omniswitch-api -n payments

# View pods
kubectl get pods -n payments -l app=omniswitch-api
```

`k8s/hpa.yaml`'s 70% CPU / 80% memory thresholds are backed by a real,
reproducible load-testing baseline, not just reasonable-looking
defaults — see [`docs/technical/load-testing.md`](docs/technical/tests/load-testing.md).

---

## ⚡ Performance

Real numbers against the actual production Docker image (Artillery load
generator, real Postgres/Redis/mock-psp — not a synthetic in-process
benchmark), resource-capped to match `k8s/deployment.yaml`'s limits
(1 CPU / 512Mi per pod). Full methodology and all findings (including why
the charge path's own ceiling can't be measured from a single machine):
[`docs/technical/load-testing.md`](docs/technical/tests/load-testing.md).

**Read path** (`GET /payments/:id`) — 90s sustained at 150 req/s, `api`
connecting through PgBouncer (transaction-mode pooling, itself capped to
`k8s/pgbouncer.yaml`'s 0.5 CPU/128Mi limits):

| Metric | Value |
|---|---|
| Success rate | 16,900 / 16,900 (100%, zero failures) |
| p50 latency | 2ms |
| p95 latency | 6ms |
| p99 latency | 10.1ms |
| max latency | 46ms |
| CPU (peak) | ~36% of 1 core |
| Memory (peak) | ~113MiB (of 512Mi limit) |

Last verified 2026-08-21 with PgBouncer (`pgbouncer-master`/
`pgbouncer-replica`) added in front of Postgres — connection-count
headroom under `k8s/hpa.yaml`'s scale-out, see
[`docs/technical/k8s/data-layer.md`](docs/technical/k8s/data-layer.md)
for the full reasoning. Matches or beats the pre-PgBouncer
baseline on every metric once
the poolers are resource-isolated the way a real cluster would enforce
them; an earlier uncapped test run showed elevated CPU/tail-latency that
turned out to be host-level container contention on the test machine,
not a PgBouncer-inherent cost — see
[`docs/technical/load-testing.md`](docs/technical/tests/load-testing.md)
(Finding #3) for the full story, including that confound.

<details>
<summary>Prior baseline (before PgBouncer, 2026-08-21)</summary>

| Metric | Value |
|---|---|
| Success rate | 16,900 / 16,900 (100%, zero failures) |
| p50 latency | 2–3ms |
| p95 latency | 6–7.9ms |
| p99 latency | 10.9–13.9ms |
| CPU (steady-state / peak) | ~1% / ~23% of 1 core |
| Memory (steady-state / peak) | ~61–63MiB / ~104MiB (of 512Mi limit) |

Measured after the `uuid` → native `crypto.randomUUID()`/`crypto`-based
`uuidv5` swap and the accumulated dependency bumps since 2026-08-10
(TypeORM 1.1, jest 30, pg 8.23, stripe 22, `@typescript-eslint` 8.67).

</details>

---

## 🔐 Security Notes

1. **Never commit** `.env.local`, `.env.production`, or real secrets
2. **K8s secrets**: Use [External Secrets Operator](https://external-secrets.io/) or [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) in production — see [`k8s/external-secrets-example.yaml`](k8s/external-secrets-example.yaml) for a concrete (illustrative, not applied by any deploy path here) example targeting the same `omniswitch-secrets` object `k8s/deployment.yaml` already references
3. **HMAC keys**: Per-merchant keys are stored in the database and rotatable via the admin API (`POST /admin/merchants/:id/rotate-hmac-secret`); rotate on a schedule (e.g. every 90 days) and immediately on suspected compromise
4. **JWT**: Use RS256 (asymmetric) in production instead of HS256
5. **JWT revocation**: Tokens can be revoked before their natural expiry — self-service logout (`POST /api/v1/auth/revoke`) and admin-triggered revocation (deactivation, credential rotation, `POST /api/v1/admin/merchants/:id/revoke-sessions`) all take effect immediately. This adds a hard dependency on Redis for *every* authenticated request, not just idempotency — see [`docs/technical/security-and-compliance.md`](docs/technical/security-and-compliance.md#jwt-revocation) for the full trade-off discussion before relying on this in production.
6. **`hmac_secret` is envelope-encrypted**, not plaintext — `merchants.hmac_secret_ciphertext` holds Vault Transit ciphertext (`VaultTransitService`); the app only ever holds the plaintext key briefly, in memory, at creation/rotation/verification time. A database compromise alone yields ciphertext, not usable signing keys. See [`docs/technical/secret-management.md`](docs/technical/secret-management.md) for the design and, importantly, what it doesn't cover — `docker-compose.yml`'s `vault` service is dev-mode only (in-memory storage, a static root token) and is **not** production-ready as deployed here.
7. **Database migrations**: `synchronize` is `false` in every environment; schema changes go through versioned migrations (`npm run migration:generate`/`migration:run`), applied automatically by the Docker image's startup command and by the e2e suite. See [`docs/technical/database-migrations.md`](docs/technical/database-migrations.md#backward-compatible-migrations-across-a-rolling-deploy) for the expand/contract policy old and new app versions running against the same schema during a rolling deploy requires — enforced by reviewer discipline, not a CI gate.
8. **MFA (PCI DSS Req 8.4.2) is opt-in for `MERCHANT`/`OPERATOR`/`READONLY`, mandatory for `ADMIN`** — `RolesGuard` rejects any request from an `ADMIN`-role caller whose merchant doesn't have `mfaEnabled`, on every `@Roles(...)`-gated route. `POST /auth/mfa/enroll`/`confirm` stay reachable without MFA so an `ADMIN` merchant (including the one `npm run seed:admin` creates) can complete enrollment rather than being locked out with no way back in. See [`docs/technical/security-and-compliance.md`](docs/technical/security-and-compliance.md#mfa--whats-covered-and-what-isnt) for what this still doesn't cover.

### PCI DSS

This API is designed to stay out of PCI DSS scope by never touching raw
card data — `cardToken`/`paymentMethodId` must be opaque references from
client-side tokenization (Stripe.js, Adyen Web Components), and the server
rejects any value that looks like an actual card number. That puts the
intended integration in the **SAQ A / SAQ A-EP** family, the lightest PCI
DSS self-assessment tiers.

**This is not a compliance certification.** Whether a specific deployment
actually qualifies, and what else is required (MFA on admin access, key
management for `hmac_secret`, centralized tamper-evident logging, mandatory
third-party ASV scans and penetration testing), is covered honestly —
including the gaps — in
[`docs/technical/security-and-compliance.md`](docs/technical/security-and-compliance.md#pci-dss-compliance).
Read that before representing this project as PCI-compliant to anyone.

---

## ⚠️ Known Limitations

Every capability listed under **Key Features** above has a real,
working mechanism behind it — verified end-to-end against real Docker
infrastructure (Postgres, Redis, Vault, a mock PSP server), not mocked
out. What's listed here isn't missing functionality; it's the specific
parts that are deliberately illustrative, uncalibrated, or scoped out —
worth knowing before treating this as more finished than it is. Fuller
write-ups: [`DEV_README.md`](DEV_README.md) (technical/infra framing) and
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md)
(business framing).

**Infrastructure**
- **Secrets**: `hmac_secret` is envelope-encrypted (Vault Transit), but
  `JWT_SECRET`/`HMAC_SECRET`/DB credentials are still plain environment
  variables delivered via a base64'd `k8s/secret.yaml`, and
  `docker-compose.yml`'s Vault runs in dev-mode (in-memory storage, a
  static root token). A concrete example
  ([`k8s/external-secrets-example.yaml`](k8s/external-secrets-example.yaml))
  and a written migration path exist for both
  (`docs/technical/secret-management.md#migration-path-for-k8s-level-secrets-and-production-vault`),
  but neither has executable code verified against real infrastructure —
  this repo has no cloud account or production Vault cluster to test
  against.
- **Observability**: `/metrics` covers PSP health, ledger outbox backlog,
  payment volume by status/provider, and reconciliation mismatches — all
  real, and [`monitoring/alert.rules.yml`](monitoring/alert.rules.yml)
  turns them into real alerts, evaluated by a real Prometheus/Alertmanager
  in `docker-compose.yml` (see
  [`docs/technical/incident-response.md`](docs/technical/incident-response.md)).
  Centralized log shipping has a concrete shape
  ([`k8s/log-shipping-example.yaml`](k8s/log-shipping-example.yaml)) but,
  like the secrets examples above, isn't verified against a real backend.
  Distributed tracing (OpenTelemetry — see `src/tracing.ts`) covers
  HTTP/DB/Redis/PSP-`fetch` calls via auto-instrumentation plus manual
  `saga.route`/`saga.charge` spans (`payment-checkout.saga.ts`), exported
  via OTLP to `docker-compose.yml`'s `jaeger` service locally; not yet
  run against real traffic end-to-end in this pass (no Docker daemon
  available in the session that wired it up) — verify with a real charge
  and confirm the trace shows up at `:16686` before relying on it.
- **Fee model**: per-merchant flat rates and volume-based tiers are both
  real and enforced — this is a separate concept from PSP interchange
  cost (what Stripe/Adyen charge *this platform*), which is a distinct
  gap: the smart-routing cost estimate (`PspFeeScheduleService`) is now
  configurable per-deployment instead of hardcoded, and
  `POST /admin/psp-cost-reconciliation/run` computes that estimate for
  real against real settled charges and diffs it, automatically, against
  a real fee statement fetched via `PSPAdapterPort.fetchFeeStatement()`
  (an operator-supplied override is still accepted, e.g. to reconcile
  against a downloaded real PSP statement instead). Against
  `mock-psp`'s `/statement` endpoints in this environment, that's a
  deterministic *simulated* real fee — real per-transaction variance
  (a "premium card" surcharge on a fifth of transactions), not the same
  flat rate as the estimate — proving the reconciliation math against
  genuine drift rather than an unrealistic exact match every time.
- **Multi-region / DR**: today's `k8s/` is one cluster in one region —
  losing a node/AZ/region takes down Postgres and Redis (the app tier
  alone scales to multiple replicas; the stateful layer doesn't). A
  concrete active-passive cross-region design exists, with RTO/RPO
  targets, a per-component plan, and a failover drill runbook
  ([`docs/technical/disaster-recovery.md`](docs/technical/disaster-recovery.md)),
  but it has never been executed against a real second region — no
  multi-region cloud account was available to build and drill against.
- **Compliance certification: none.** This project holds **no
  third-party compliance certification of any kind** — not SOC 2 (Type I
  or Type II), not PCI DSS Level 1 (a QSA-assessed report, distinct from
  the self-assessed SAQ tier discussed above), not ISO 27001. Everything
  under "PCI DSS" above and in
  [`docs/compliance/`](docs/compliance/)/[`docs/technical/compliance-certification-roadmap.md`](docs/technical/compliance-certification-roadmap.md)
  is a self-assessment and a priced, sequenced roadmap for pursuing real
  certification — not evidence that certification exists today. Closing
  this requires a real third-party auditor, a real observation period,
  and a real budget; none of that is something this repository, as code,
  can produce on its own.
- **One reviewed, documented SAST exception.** `bearer.ignore` (repo
  root) records a Bearer SAST finding on `sdk/go/http_sender.go`
  (flagged as CWE-918/SSRF) judged a false positive for this codebase —
  the flagged URL is caller-supplied client configuration, never
  attacker-reachable input, the same shape as any HTTP client library.
  See
  [`docs/technical/security-and-compliance.md#sast-findings-documented-reviewed-exceptions`](docs/technical/security-and-compliance.md#sast-findings-documented-reviewed-exceptions)
  for the full reasoning and the defense-in-depth check added anyway.

**Business domain — illustrative or uncalibrated, not fully open**
- **Recurring billing**: the hard-decline code set (which failures skip
  retry and cancel immediately) is a small, reasonable set, not validated
  against real-world decline-code taxonomies. No real notification
  integration is subscribed to the events this system emits.
- **Marketplace payouts**: KYC review and bank transfers each have a
  real, async-settling provider (Persona for KYC; ACH/wire for
  transfers) selectable alongside a synchronous mock default — the
  mechanism is genuinely runnable end-to-end (real webhook confirmation,
  real signature verification), but no real provider has ever actually
  been called with real credentials, since none exist in this repository
  or its CI. A reserve released independently of its payout's own
  transfer gets its own follow-up transfer through the same rail.
- **Risk tiering & reserves**: three illustrative, round-number tiers
  driven by one lost-dispute-rate signal — not calibrated against real
  fraud/chargeback data, and missing signals a real model would use (MCC
  code, account tenure, dispute reason code).
- **Dispute resolution policy**: auto-accept/contest thresholds and the
  reason-code table are illustrative, not derived from real chargeback
  win-rate data; no connection to a merchant's own risk tier.
- **Cross-border settlement**: no hedging/rate-lock product for a
  merchant wanting a guaranteed rate ahead of a sale; VAT/tax handling
  isn't modeled at all.
- **Agentic payments**: a charge above `requireApprovalAboveAmount` (but
  within the delegation's hard per-transaction limit) holds for a human
  operator to approve or deny instead of auto-executing or being
  rejected outright — see `ChargeApprovalController`. Agent-initiated
  charges get two additional risk signals on top of the same amount/card
  scoring every charge gets (whether this is the delegation's first
  charge to this merchant; how much of its remaining monthly budget this
  charge alone would consume) — two concrete heuristics, not a full
  agent-specific fraud model, and neither accounts for a delegation's
  history across other merchants. Who's liable when an agent makes an
  incorrect purchase is a real, unresolved industry question this system
  doesn't decide — only the audit trail (which delegation, human- or
  agent-initiated) is captured. Per-agent request signing is implemented
  — every `POST /delegations` issues its own HMAC signing key alongside
  the agent JWT, and `HmacSignatureGuard` requires and verifies it on
  every agent-initiated charge, the same signature scheme merchant
  requests use, just keyed by the delegation instead of the merchant.

---

## 📚 Documentation

Deeper documentation than fits in this README lives in [`docs/`](docs/),
split into:

- **[`docs/guide/`](docs/guide/)** — **new to this project? Start
  here.** A structured onboarding path: the full business-domain guide,
  a system design document (architecture, request flows, how to change
  the system safely), and a complete API reference for every endpoint —
  meant to be read start to finish before you touch code.
- **[`docs/technical/`](docs/technical/)** — architecture, module
  boundaries, security design, PCI DSS compliance posture
- **[`docs/business-domain/`](docs/business-domain/)** — payment lifecycle,
  ledger/settlement model, smart routing logic, domain glossary — written
  for understanding *what the system does*, independent of implementation.
  Includes
  [`future-directions.md`](docs/business-domain/future-directions.md), the
  full business-framing version of the "Known Limitations" section above
  — as opposed to [`DEV_README.md`](DEV_README.md)'s Tier 1–3, which is
  the technical, implementation-level version of the same gaps.
- **[`docs/compliance/`](docs/compliance/)** — AML data-retention policy:
  what gets archived/deleted, on what schedule, and how to reconfigure
  the retention periods (`ARCHIVE_THRESHOLD_DAYS`,
  `DELETION_THRESHOLD_YEARS`, and related env vars) for a specific
  jurisdiction without a code change
Start at [`docs/README.md`](docs/README.md).

---

## 📊 PSP Smart Routing Logic

```
Request → BIN Lookup → Country Detection
         ↓
    EU Card? → Prefer ADYEN (PSD2/SCA compliance)
    US Card? → Prefer STRIPE (lower fees)
    High Amount (>$10k)? → Prefer ADYEN (better enterprise rates)
         ↓
    Check Circuit Breaker State (CLOSED/HALF_OPEN/OPEN)
         ↓
    Calculate Score (successRate + latency + fee + availability)
         ↓
    Select Highest Score → Execute → Fallback on failure
```

---

## 📝 License

**All Rights Reserved** — see [`LICENSE`](./LICENSE) for the full text.
This is a proprietary reference project: viewing and reading the code is
welcome, reuse or redistribution is not, without permission.

See also [`CONTRIBUTING.md`](./CONTRIBUTING.md) (what kind of issues are
welcome, and why this isn't set up for external code contributions),
[`SECURITY.md`](./SECURITY.md) (how to report a vulnerability privately),
and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
