# Glossary

Domain and payments-industry terms as they're used in this codebase
specifically — some of these have broader or slightly different meanings
elsewhere.

| Term | Meaning here |
|---|---|
| **PSP** | Payment Service Provider — Stripe or Adyen in this codebase (`PSPProvider` type also reserves `PAYPAL`/`CHASE` but neither has an adapter implemented). |
| **Acquirer** | The bank/institution that actually settles card transactions on the merchant's behalf. Used loosely here as a synonym for "PSP" (`AcquirerRoutingService` picks a PSP, not literally a bank). |
| **PAN** | Primary Account Number — the actual card number. This system is designed to never see one; see `docs/technical/security-and-compliance.md`. |
| **Tokenization** | Replacing a PAN with an opaque reference (`cardToken`/`paymentMethodId`) generated client-side by the PSP's SDK, before it ever reaches this backend. |
| **BIN** | Bank Identification Number — the first 6–8 digits of a card number, used for routing decisions (issuing country, brand) without needing the full PAN. See `BinInfo`. |
| **Idempotency Key** | A client-generated UUID sent on every mutating request so a retried request (e.g. after a network timeout) replays the original result instead of executing twice. Not the same as `paymentId`. |
| **Authorization (auth)** | A PSP confirming funds are available and placing a hold, without transferring them yet. Corresponds to `REQUIRES_CAPTURE` status (`captureMethod: "manual"`). |
| **Capture** | Actually collecting funds that were previously authorized. `POST /payments/:id/capture`. |
| **SCA / 3DS(2)** | Strong Customer Authentication / 3-D Secure — an extra authentication step (typically bank-side, e.g. a push notification) required for certain card payments, especially under EU PSD2 rules. Modeled here as the `REQUIRES_ACTION` status. |
| **Risk score** | A 0–100 number computed by `PaymentAggregate.calculateRiskScore()` from transaction amount and card origin, stored for audit but not used to gate anything — the PSP's own response is what actually decides `REQUIRES_ACTION`. Not a fraud-detection model — a simplified stand-in for one. |
| **Circuit breaker** | Per-PSP-adapter failure tracking (`CLOSED`/`OPEN`/`HALF_OPEN`) that temporarily stops routing traffic to a PSP that's failing repeatedly. See `ledger-and-settlement.md`. |
| **Outbox pattern** | Writing an event to the database in the same transaction as the state change it represents, then relaying it asynchronously — used here for ledger entries. See `ledger-and-settlement.md`. |
| **Saga** | An orchestrated multi-step business transaction with explicit compensating actions on failure, instead of a single ACID transaction (because it spans an external PSP call, which can't be rolled back like a DB write). `PaymentCheckoutSaga`. |
| **Merchant** | A tenant of the gateway — the entity being charged on behalf of, and the identity a JWT/API key belongs to. Not the payer/customer. |
| **`merchantId` vs. merchant `id`** | `MerchantEntity.id` is an internal UUID primary key. `MerchantEntity.merchantId` is the business-facing identifier used in JWTs, ledger account IDs, and API URLs (`/admin/merchants/:merchantId/...`). Don't confuse the two when reading code. |
| **HMAC signature** | A per-request `X-Signature` header (HMAC-SHA256 over timestamp + method + path + raw body) that proves the request wasn't tampered with in transit and came from someone who knows the merchant's `hmacSecret`. Independent of JWT auth — JWT proves *who* is calling, HMAC proves the *specific request body* is intact. |
| **`jti`** | JWT ID — a unique identifier embedded in each issued token, used to revoke that specific token without affecting any other token issued to the same merchant. |
| **Dispute / Chargeback** | A cardholder or issuing bank contesting a charge after the fact. Only ever originates from the PSP via webhook (`charge.dispute.created` / `CHARGEBACK`) — there's no API to create one directly. Maps to the `DISPUTED` status. |
| **Settlement** | The actual movement/reconciliation of funds between the PSP and the platform's bank account, happening on the PSP's own schedule (typically T+1/T+2). This codebase's ledger records the *accounting* of a settlement, not the literal bank transfer. |
| **Subscription** | A domain object that *produces* a new `Payment` every billing period (`TRIALING`/`ACTIVE`/`PAST_DUE`/`CANCELED`), rather than being a payment itself — see `subscriptions.md`. |
| **Plan** | A merchant-defined, reusable subscription template (name/amount/currency/interval) a `Subscription` can reference instead of carrying its own pricing directly. Immutable once created — a price change is a new `Plan`, not an edit. |
| **Dunning** | The retry policy applied when a subscription's renewal charge fails — a fixed day 1/3/7 backoff for a retryable decline, or immediate cancellation for a hard decline (e.g. `stolen_card`). See `subscriptions.md`. |
| **Platform account / Connected account** | Marketplace roles a `Merchant` can have (`MerchantEntity.accountType`): a `PLATFORM` merchant can route part of a charge directly to one or more `CONNECTED` merchants onboarded under it (a "split"), which receive their own `Payout`s. Mirrors Stripe Connect's platform/connected-account model. |
| **Payout** | A batched, scheduled record of a connected merchant's split proceeds actually being paid out, net of any rolling reserve withheld — distinct from the ledger credit booked at charge time, which only records that the money is owed. |
| **Reserve (Reserve Hold)** | A configurable slice of a charge's net amount withheld for a hold period before being released — either a merchant-level risk reserve (`MerchantEntity.reserveBps`/`reserveHoldDays`) or a marketplace payout's own reserve. See `ledger-and-settlement.md`. |
| **KYC** | Know Your Customer — identity/business verification a connected merchant must pass before its payouts (not charges) can actually be transferred. Modeled here as `MerchantEntity.kycStatus`, checked via a real (mocked) `KYCProviderPort`. |
| **Delegation** | A narrow, revocable credential a merchant grants an autonomous agent to charge on its behalf, distinct from the merchant's own full-access JWT — see `future-directions.md#agentic-payments`. Carries a `SpendPolicy` and its own `jti`, revoked the same way a merchant session is (see `security-and-compliance.md`). |
| **Spend Policy** | The business rules attached to a `Delegation`: a per-transaction limit, a rolling calendar-month limit, and an optional category allowlist — enforced atomically before a `Delegation`'s charge ever reaches a PSP. |
| **Agent** | The `UserRole.AGENT` principal type — a JWT issued by `POST /delegations`, accepted on exactly one route (`POST /payments/charge`), scoped and rate-limited by its `Delegation`'s `SpendPolicy` rather than the merchant's own unrestricted authority. |
