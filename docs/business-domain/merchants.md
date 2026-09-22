# Merchants: Onboarding, Trust & the Account Lifecycle

`Merchant` is the tenant model everything else in this system hangs off
of — every charge, dispute, payout, and agent delegation belongs to one.
This document is the "why" behind how a `Merchant` comes into existence
and how this platform's trust in it changes over time. It deliberately
doesn't repeat the API contract (see
[`../guide/api/merchants-and-auth.md`](../guide/api/merchants-and-auth.md))
or the technical mechanism (see
[`../technical/security-and-compliance.md`](../technical/security-and-compliance.md))
— both are cross-referenced throughout instead of duplicated.

## What a Merchant actually is

A `Merchant` is simultaneously three things, and keeping them distinct
matters for reasoning about the system correctly:

1. **A credential holder** — an API Key ID + Secret (login) and a
   per-merchant HMAC signing key (request authenticity). See
   [`../technical/secret-management.md`](../technical/secret-management.md)
   for how both are protected at rest.
2. **A configuration record** — fee rate, settlement currency, PSP
   entitlement, reserve policy, notification routing. Every one of
   these defaults to "no behavior change," so a merchant created before
   a given feature existed is never silently affected by it.
3. **A trust subject** — the thing this platform's risk, compliance, and
   sanctions posture is actually evaluated *against*, continuously, not
   just once at creation. Most of this document is about that third
   role, since it's the least visible from reading the entity's column
   list alone.

`merchantId` (business-facing, used in JWTs and ledger account IDs) and
the internal `uuid` primary key are deliberately different things — see
[`glossary.md`](./glossary.md) if the distinction isn't already familiar.

## Account types: PLATFORM and CONNECTED

Every merchant defaults to `PLATFORM` — a flat peer with no special
relationship to any other merchant. `CONNECTED` marks a sub-merchant
onboarded *under* a platform merchant, able to receive a portion of that
platform's charges directly (a "split") and get its own scheduled
payouts. This is deliberately **one level deep only** — a `CONNECTED`
merchant can't itself have connected accounts — the same platform/seller
shape Stripe Connect and Adyen for Platforms use, not an arbitrary org
tree. See
[`marketplace-and-payouts.md`](./marketplace-and-payouts.md) for the
full splits/payout mechanism.

This distinction matters for everything else in this document: a
`PLATFORM` merchant is usually a real, operating business integrating
directly; a `CONNECTED` merchant is someone *that business* is vouching
for by listing them on its marketplace. The two carry genuinely
different verification obligations, which is why onboarding below
branches on `accountType`.

## Onboarding: from `POST /admin/merchants` to a trusted, chargeable tenant

Onboarding isn't a single event — it's a short pipeline, and a merchant
can sit in an intermediate state (created, but not yet fully cleared)
for a real amount of time when a real verification provider is involved.

### Step 1 — Identity capture and sanctions screening, at creation

`POST /admin/merchants` accepts an optional `legalName`/`taxId` in
addition to the required display `name`. This isn't cosmetic: it's the
one piece of real-world identity this platform can check *before* any
money ever moves, and it exists specifically to support **sanctions/
watchlist screening**, which runs synchronously as part of merchant
creation itself — not a later, separate step:

- A confirmed match against a real sanctions list (`HIT`) **blocks
  creation outright** — the merchant, its API key, and its HMAC secret
  are never created. This is deliberately the one onboarding check in
  this system that isn't "create now, gate something later" — screening
  who you're doing business with at all is a legal obligation
  independent of whether that party ever gets to charge or receive a
  payout. See
  [`compliance-and-security.md`](./compliance-and-security.md#sanctionswatchlist-screening-who-this-platform-is-legally-required-to-refuse)
  for the regulatory framing and
  [`risk-and-fraud.md`](./risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening)
  for the full mechanism (match confidence tiers, periodic re-screening,
  notification, manual review).
- A lower-confidence fuzzy match (`POTENTIAL_MATCH`) does **not** block
  creation — common names produce false positives, and refusing every
  ambiguous match would refuse real merchants over coincidence. The
  merchant is created normally, flagged for a human to clear or confirm.
- If `legalName` is omitted (still allowed — it's optional, not required,
  since not every integration is ready to supply it at signup), screening
  falls back to the display `name` and the result is recorded at
  *degraded* confidence — good enough to catch an obvious, exact-name
  match, not a substitute for a real legal name once one is available.
  Submitting a `legalName` later (KYC submission, or a dedicated update)
  re-screens at full confidence and supersedes the degraded result.

### Step 2 — KYC, for CONNECTED merchants only

A `CONNECTED` merchant additionally needs `POST
/admin/merchants/:id/kyc/submit` (`{ legalName, taxId }`) before its
payouts — not its charges — can be transferred. See
[`marketplace-and-payouts.md#connected-account-kyc`](./marketplace-and-payouts.md#connected-account-kyc)
for why payouts and charges are gated independently, and for the
real-async-provider mechanism (`KYCProviderPort`). The `legalName`
submitted here also re-screens sanctions at full confidence — a
`CONNECTED` merchant that only ever supplied a display name at creation
gets its degraded-confidence screening result upgraded the moment real
KYC data exists.

### Step 3 — KYB, for CONNECTED merchants only

KYC confirms an *individual's* identity, not the *business* itself —
company registration, tax ID validity, or who actually owns/controls it
(UBO). `POST /admin/merchants/:id/kyb/submit` (`{ legalName, taxId,
country, beneficialOwners? }`) answers that separate question, via the
same real-provider pattern KYC uses (`KYBProviderPort`, its own
`MockKYBProviderAdapter`/`PersonaKybProviderAdapter`, its own
`POST /webhooks/kyb` decision callback with a distinct signing secret
from KYC's). `kybStatus` is tracked entirely independently of
`kycStatus` — a merchant can be `kycStatus: 'VERIFIED'` (the individual
checks out) while `kybStatus` is still `NOT_STARTED` (the business
itself was never separately verified), because those genuinely are two
different questions with two different answers.

**KYB does not gate payouts the way KYC does** — a deliberate scope
limit, not an oversight. Wiring a *second* verification into the same
payout gate KYC already uses would conflate "should this specific
transfer be held" (KYC's job) with "is this a business we've fully
underwritten" (a broader question this pass doesn't try to answer yet).
KYB is captured and exposed as underwriting data for a human (or a
future automated policy) to act on — the same "visibility first,
automation later" posture `ambiguousRiskFlagged` already established
for a different signal. Real underwriting decisions (reserve policy,
payout limits) still depend on `MerchantEntity` fields an operator sets
largely by hand (MCC code, reserve basis points) until that wiring is
built.

The submitted `legalName` also re-screens sanctions at full confidence,
same as KYC submission — see
[`risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening`](./risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening).
**Beneficial-owner data is not itself screened yet** — only the
business's own `legalName` is — screening each UBO individually against
the sanctions list is a real next step this pass doesn't take.

**Retention for beneficial-owner data is an open question.**
`kybBeneficialOwners` stores names and ownership percentages — real PII
this codebase's own data-retention policy doesn't yet have a documented
answer for (see
[`../compliance/data-retention.md`](../compliance/data-retention.md)).
This pass captures the data a real KYB flow needs; deciding how long to
keep it is a compliance decision, not an engineering one this document
can settle unilaterally.

## Trust isn't decided once — four independent signals, evaluated continuously

Once a merchant exists, this platform keeps evaluating it against four
genuinely independent signals. They're deliberately not merged into one
score — a fraud signal, a PSP-reliability signal, an AML signal, and a
legal sanctions signal answer different questions, and conflating them
would make each individually less legible to whoever has to act on it.
See [`risk-and-fraud.md#why-two-separate-signals-not-one-risk-score`](./risk-and-fraud.md#why-two-separate-signals-not-one-risk-score)
for the fuller argument, which extends to all four, not just the
original two.

| Signal | Question it answers | Automated action | Re-evaluated |
|---|---|---|---|
| **Risk tiering** ([`risk-and-fraud.md`](./risk-and-fraud.md#risk-tiering-chargeback-driven-reserves)) | How much of this merchant's money should sit in reserve, given its chargeback history? | Adjusts `reserveBps`/`reserveHoldDays` automatically, both up and down | Daily sweep |
| **Ambiguous-risk monitoring** ([`risk-and-fraud.md`](./risk-and-fraud.md#ambiguous-risk-monitoring-psp-reliability-signal)) | Is this merchant's traffic hitting an unusual rate of PSP-outcome ambiguity? | Visibility flag only, auto-clears after a quiet period | Inline, on each incident |
| **AML review observation** ([`risk-and-fraud.md`](./risk-and-fraud.md#aml-review-observation-high-industry-hard-decline-signal)) | Is a `HIGH`-industry merchant racking up hard-declines fast enough to warrant a human look? | Visibility flag + real-time notification, no auto-clear | Inline, on each hard decline |
| **Sanctions screening** ([`risk-and-fraud.md`](./risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening)) | Has this merchant (or its legal name) since appeared on a sanctions list it wasn't on at onboarding? | `HIT` is a hard block on *new* delegations (see below); does not retroactively freeze existing activity — that's a manual decision | Weekly sweep + on demand |

Three of the four (risk tiering, ambiguous-risk, AML review) share an
explicit **"manual input pauses automation"** posture: an operator's
manual override (`PATCH .../reserve-policy`, `.../ambiguous-risk`,
`.../aml-review`) flips that signal's own `*AutoManaged` flag to `false`
and it sticks until the operator explicitly re-enables it. Sanctions
screening doesn't have this override concept in the same shape — a
`HIT` is a factual claim about a real external list, not a judgment call
an operator's local override should silently paper over; instead it's
resolved via `PATCH .../sanctions-review`, which records who reviewed it
and why (false positive vs. confirmed) without touching whether the next
scheduled re-screen still runs.

## Sanctions HIT and agent delegations

`DelegationEntity.agentName` (e.g. `"inventory-restock-bot"`) is a
merchant-chosen label for a piece of software, not a legal identity —
screening it against a sanctions list the way a person's or a
company's name is screened would be meaningless. Instead, a merchant
whose `sanctionsScreeningStatus` is `HIT` cannot have *new* delegations
created at all — `DelegationService.createDelegation()` checks the
parent merchant's status before issuing an agent token. This is the same
shape as KYC gating payouts rather than charges: the restriction attaches
to the *capability a known-bad state shouldn't extend*, not to an
identity that was never the actual subject of the check. See
[`compliance-and-security.md#agentic-payments-delegation-scope-as-a-liability-limiting-decision`](./compliance-and-security.md#agentic-payments-delegation-scope-as-a-liability-limiting-decision)
for the broader delegation liability framing.

## Fee model, settlement, and PSP entitlement (briefly — see the dedicated docs)

Three more per-merchant configuration axes exist and are covered in
full elsewhere, cross-referenced here only for completeness of "what a
Merchant actually configures":

- **Fee rate** — flat `platformFeeBps`, optionally superseded by
  volume-based tiers. See
  [`fee-model.md`](./fee-model.md#platform-fee-rate).
- **Settlement currency** — which currency a charge's ledger entry
  settles in, if different from the charged currency. See
  [`fx-conversion.md`](./fx-conversion.md).
- **PSP entitlement** — which PSPs (`STRIPE`/`ADYEN`) a merchant's
  charges may route through at all, on top of smart routing's own
  PSP selection. See
  [`ledger-and-settlement.md#smart-psp-routing`](./ledger-and-settlement.md#smart-psp-routing).

## Notification configuration: one channel per event family, deliberately

Disputes, subscriptions, and AML-review flags each have their own
independent `*NotificationChannel`/`*NotificationTarget` pair
(`EMAIL`/`SLACK`/`WEBHOOK`), and sanctions screening follows the same
shape rather than sharing one of the existing three. The reasoning is
consistent across all of them: a merchant might reasonably want, say,
Slack for disputes and a webhook for sanctions hits — these are
different audiences (support/ops vs. compliance) inside the same
merchant organization, and forcing one shared channel would mean
someone's actionable alert gets buried in someone else's noisy channel.
Ambiguous-risk monitoring is the deliberate exception — it's silent by
design (see [`risk-and-fraud.md`](./risk-and-fraud.md#ambiguous-risk-monitoring-psp-reliability-signal)),
not an oversight.

## Credentials and sessions (cross-reference only)

API key rotation, HMAC key rotation, MFA enforcement for `ADMIN`-role
callers, and merchant-wide session revocation are all part of the
`Merchant` lifecycle but are security mechanisms, not business-domain
decisions — see
[`../technical/security-and-compliance.md`](../technical/security-and-compliance.md)
for JWT revocation and MFA, and
[`../technical/secret-management.md`](../technical/secret-management.md)
for how the API key secret and HMAC key are stored.
