# Regulatory Compliance & Information Security

This describes *why* compliance and security requirements shaped several
domain-model decisions in this system — written for someone reasoning
about the business, not auditing the code. For the technical/audit-ready
detail this document deliberately doesn't repeat, see:

- [`../technical/security-and-compliance.md`](../technical/security-and-compliance.md) —
  JWT revocation design, the full PCI DSS scope/gap assessment
- [`../technical/compliance-certification-roadmap.md`](../technical/compliance-certification-roadmap.md) —
  the SOC 2 certification path, and a real ASV-scan/penetration-test
  budget
- [`../compliance/data-retention.md`](../compliance/data-retention.md) —
  AML record-keeping: what's kept, for how long, and how to configure it
  for a real jurisdiction

## Why this belongs in the domain model, not just the security layer

A payment gateway's core product *is* trust — an acquiring bank or card
network can revoke a platform's ability to process cards at all over a
compliance failure, independent of whether the underlying software bug
was ever exploited. That's a different, harsher failure mode than most
software has: "we'll patch it" isn't always available once a network
partner has already pulled the relationship. Several decisions in this
codebase that read as pure engineering choices are actually regulatory
decisions wearing engineering clothes — this document is about making
that connection explicit.

## PCI DSS: the tokenization decision is a business decision

The single biggest compliance-driven design decision in this system is
that it **never receives a raw card number at all** — `cardToken`/
`paymentMethodId` are opaque references produced by client-side
tokenization (Stripe.js, Adyen Web Components), not something this
backend ever unwraps. Architecturally this looks like "use the PSP's
SDK"; from a business/compliance standpoint it's the decision that
determines which PCI DSS Self-Assessment Questionnaire tier this
platform can even claim — the lightest tiers (SAQ A / SAQ A-EP) are
reserved specifically for merchants who never touch cardholder data
themselves. Landing in scope for a heavier SAQ tier (or a full Report on
Compliance) is a materially larger, ongoing audit burden — this decision
was made once, at the architecture level, specifically to avoid that.

**What this means for an integration partner**: any merchant integrating
with this platform inherits this same scoping benefit *only if their own
frontend* also never touches raw card data — whether a specific
integration lands on SAQ A vs. SAQ A-EP depends on how *that merchant's*
frontend embeds the tokenization widget, a decision this backend can't
make on their behalf. That's a real integration-contract implication,
not just an internal engineering note.

## AML/KYC: why payouts are gated and charges aren't

A marketplace platform routing money to connected sellers has a real
regulatory obligation most single-merchant payment processors don't:
knowing who it's actually paying. `MerchantEntity.kycStatus` gates
whether a `CONNECTED` merchant's payout can be *transferred* — but
deliberately **not** whether that merchant can be a split recipient and
accumulate ledger credit in the first place. That split (mirroring real
Stripe Connect's `charges_enabled`/`payouts_enabled` distinction) is
itself a compliance-shaped decision: the regulatory obligation is about
*moving money to* an unverified party, not about *crediting an internal
ledger entry* to one — conflating the two would block legitimate platform
operation (a seller listing products, accumulating sales) over a
requirement that only actually applies at the moment money would
actually leave the platform. See
[`risk-and-fraud.md`](./risk-and-fraud.md) and
[`marketplace-and-payouts.md`](./marketplace-and-payouts.md#connected-account-kyc)
for the mechanism.

## Sanctions/watchlist screening: who this platform is legally required to refuse

`KYCProviderPort.verify()` answers "is this business who it says it
is" — a genuinely different question from "is this business, or the
individual behind it, on a list this platform is legally required to
refuse to do business with at all." Sanctions/watchlist screening
(`SanctionsScreeningPort`) answers the second question, and it's a
distinct check for a reason that matters beyond neatness: it runs
**before** KYC even applies, at merchant creation itself, for both
`PLATFORM` and `CONNECTED` merchants — this is a legal screening
obligation, not a marketplace-onboarding nicety scoped only to connected
sellers.

A confirmed match blocks onboarding outright, not just a downstream
capability like payouts. This is deliberately *not* KYC-shaped: "create
the account but hold back one capability" (what KYC does — see
[`marketplace-and-payouts.md#connected-account-kyc`](./marketplace-and-payouts.md#connected-account-kyc))
is the right posture for a merchant that's merely unverified yet; it's
the wrong one for a party this platform isn't legally allowed to
transact with at all. See
[`../guide/api/merchants-and-auth.md`](../guide/api/merchants-and-auth.md)
for the endpoint contract and
[`risk-and-fraud.md`](./risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening)
for the full mechanism, including why a fuzzy/low-confidence match is
handled very differently from a confirmed one.

## Agentic payments: delegation scope as a liability-limiting decision

`Delegation`/`SpendPolicy` (see
[`future-directions.md`](./future-directions.md#agentic-payments)) look
like an authorization feature, but the *narrowness* of what they grant
is a deliberate liability decision: an agent's JWT is accepted on
exactly one route, carries a hard spend ceiling enforced *before* a PSP
is ever called, and is revocable in real time. Each of those specifically
bounds what damage a compromised or misbehaving agent credential can do
— the same reasoning a real business would apply before letting
autonomous software hold *any* purchasing authority, not a technical
nicety. **What this doesn't yet answer**: if an agent makes an incorrect
purchase, who is actually liable for resolving it — the platform, the
merchant, or whoever operates the agent? This is a genuinely unresolved
question industry-wide, not something this project can settle
unilaterally; the audit trail (`delegationId`/`initiatedBy` on every
agent-initiated payment) is the building block a real liability
framework would need, not an answer to the question itself.

## Cross-border: what "compliance" doesn't cover here

[`fx-conversion.md`](./fx-conversion.md#fx-conversion-merchant-settlement-currency)
covers the FX mechanism; from a regulatory-scope standpoint, the honest
gap is **VAT/tax handling isn't modeled at all** — charging a customer
in another country's currency, correctly, is a *financial* problem this
system solves; charging them the *tax* a real cross-border sale in that
jurisdiction would owe is a *legal* problem this system doesn't attempt,
and is arguably out of scope for a payment gateway to solve itself
(usually delegated to a specialized tax-calculation service in a real
deployment) — but the domain model would still need a place to record
what was charged and why, which doesn't exist today.

## Information security, in terms of what it actually protects against

The technical mechanisms (JWT revocation, HMAC request signing, Vault
Transit envelope encryption for `hmac_secret`) are documented in full in
[`security-and-compliance.md`](../technical/security-and-compliance.md).
Framed in business terms instead of mechanism terms:

- **JWT revocation existing at all** is what makes "we deactivated a
  compromised merchant credential" actually mean something within the
  hour instead of within whatever the token's remaining natural lifetime
  happens to be — the gap between those two is exactly the exposure
  window a real incident response plan gets measured against.
- **HMAC request signing** is what stops a leaked bearer token alone
  from being sufficient to move money — a second, separate secret has to
  also leak for a stolen JWT to be actionable. For agentic payments
  specifically, this is scoped per-delegation, not shared with the
  merchant's own secret — a compromised agent credential can't be used
  to forge a request *as the merchant*.
- **Envelope encryption for `hmac_secret`** means a database-only
  compromise (a leaked backup, an over-privileged read replica credential)
  yields ciphertext, not a usable signing key — the actual signing
  material only ever exists in plaintext briefly, in memory, at
  creation/rotation/verification time.

None of this is presented as "this system is secure" — see
`security-and-compliance.md`'s own honest gap list (plaintext
`JWT_SECRET`/DB credentials, dev-mode Vault) for what these mechanisms
*don't* yet close. The point here is narrower: each mechanism above
exists because of a specific business risk it closes, not because
"security" is generically good practice.
