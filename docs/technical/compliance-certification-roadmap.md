# Compliance Certification Roadmap: SOC 2 & PCI DSS

**Status: planning document, well short of a certification.** Nothing in this
repository is SOC 2 or PCI DSS certified — both require a third-party
auditor, real evidence collected over a real observation period, and
(for PCI DSS) a QSA or a completed SAQ. This document maps what this
codebase already has real evidence for, what's structurally missing, a
rough sequencing/timeline, and a concrete ASV-scan/penetration-test
budget — so a team picking this up has an actionable starting point
instead of "go figure out compliance."

PCI DSS specifics (SAQ tier, the technical gap list, the priority-ordered
punch list) already live in
[`security-and-compliance.md`](./security-and-compliance.md#pci-dss-compliance) —
this document doesn't repeat that, it adds the SOC 2 path (untouched
elsewhere in this repo) and the budget/cadence planning neither doc had.

## SOC 2

### Why SOC 2, distinct from PCI DSS

PCI DSS is card-data-specific and mandatory for anyone touching cardholder
data; SOC 2 is a general trust-and-security attestation, commonly what a
B2B payments customer's own procurement/security team asks for
independent of whether they also require PCI DSS evidence. A payment
gateway selling to other businesses typically needs both — PCI DSS to
process cards at all, SOC 2 because an enterprise customer's vendor
security review usually asks for one by name.

### Trust Service Criteria: what applies here

SOC 2 has one mandatory criterion (Security) and four optional ones an
organization selects based on relevance. For a payment gateway:

| Criterion | Applicable? | Why |
|---|---|---|
| **Security** (mandatory) | Yes | Access control, encryption, vulnerability management — directly what this repo's own security posture is about. |
| **Availability** | Yes | A payment gateway going down stops merchants from taking money — this is a real, customer-relevant promise rather than an optional add-on. |
| **Processing Integrity** | Yes | "The charge you asked for is the charge that happened, exactly once, for the right amount" is the core promise of this entire system (idempotency, the Saga, the ledger). |
| **Confidentiality** | Yes | Merchant business data (transaction volume, customer lists via `customer_id`) is confidential business information independent of cardholder data specifically. |
| **Privacy** | Depends on scope | Only if this system directly handles end-consumer PII beyond what's needed for payment processing (it currently stores minimal PII — `customer_id` is caller-supplied, collected by the caller rather than this system). Skip unless the product scope grows to justify it. |

### What this codebase already has real evidence for

Mapped to Security/Availability/Processing Integrity/Confidentiality —
this is evidence a real audit could point at — not a claim of compliance:

- **Access control**: RBAC (`RolesGuard`), MFA mandatory for `ADMIN`
  (`security-and-compliance.md`), JWT revocation with fail-closed Redis
  dependency, per-merchant HMAC request signing.
- **Encryption**: Vault Transit envelope encryption for `hmac_secret`
  and agent signing keys (`secret-management.md`) — with that doc's own
  honest caveat about `JWT_SECRET`/DB credentials still being plaintext
  env vars and dev-mode Vault not being production-ready.
- **Change management**: CI (`ci-cd.md`) — blocking lint, `tsc`,
  build, unit tests, and a separate real-infrastructure e2e job — plus
  code review as the actual gate (no auto-merge).
- **Availability**: HPA, pod anti-affinity, circuit breakers verified
  against real PSP/Redis/Postgres outages (`chaos-testing.md`), a
  documented (if unverified) DR strategy (`disaster-recovery.md`).
- **Processing integrity**: idempotency (Redis SETNX locks scoped
  per-merchant), the Saga's compensating-transaction path, the
  Transactional Outbox pattern, real regression tests for
  double-booking bugs found during development (`architecture.md`'s
  testing section).
- **Monitoring**: Prometheus + Alertmanager against real metrics
  (`incident-response.md`), reconciliation as an active drift-detection
  mechanism, beyond just logging.

### What's structurally missing — and can't come from code alone

SOC 2 evidence is as much about *organizational* controls as technical
ones — these aren't things this repository, as code, can satisfy:

- **Written policies**: an information security policy, an incident
  response *plan* (not just the runbook `incident-response.md` already
  has — a plan covering roles, escalation, communication, post-incident
  review), a change-management policy, an access-review cadence.
- **A real observation period**: SOC 2 Type II (the version that
  actually matters to most enterprise buyers — Type I only attests
  controls exist on one date, Type II attests they operated correctly
  over 3–12 months) requires evidence *collected over that period* —
  access review logs, actual incident tickets, actual deploy records.
  None of that exists yet because there's no real production history to
  audit.
- **People/process controls**: background checks, security awareness
  training, a defined vendor-risk-management process for third parties
  (Stripe, Adyen, the cloud provider) — organizational facts about a
  real company, well outside what a codebase can have.
- **A real, current architecture the auditor can actually test** —
  everything in this repo's own "Known Limitations" sections
  (plaintext `JWT_SECRET`, dev-mode Vault, no real multi-region DR) needs
  to be closed first; an auditor testing controls that don't hold up in
  production doesn't produce a useful report.

### Rough sequencing

1. Close the technical gaps `security-and-compliance.md` and this
   repo's other "Known Limitations" sections already list (real secrets
   management, centralized tamper-evident logging, real DR) — these are
   prerequisites for *both* SOC 2 and PCI DSS, do them once.
2. Write the organizational policy documents above — this can happen in
   parallel with step 1, doesn't block on code.
3. Engage a SOC 2 auditor for a **Type I** report first — faster and
   cheaper, confirms the control *design* is sound before committing to
   a multi-month Type II observation window.
4. Run the **Type II** observation period (3 months minimum, 6–12
   typical for a first report) with real production evidence
   accumulating.
5. Type II report issued — typically valid/expected to be refreshed
   annually.

## PCI DSS

See [`security-and-compliance.md`](./security-and-compliance.md#if-you-take-this-to-formal-pci-dss-certification)
for the existing priority-ordered technical punch list (frontend
tokenization scoping, secrets management, MFA — already done — centralized
logging, then QSA engagement). This section only adds what that doc
doesn't cover: budget and cadence for the two recurring third-party
obligations neither this repo nor its own code review can satisfy.

## ASV scanning & penetration testing: budget and cadence

Both are **recurring obligations** rather than one-time setup —
budget them as an annual operating cost instead of a project line item
that ends once paid.

| Item | Cadence | Rough cost (USD, small-to-mid scope) | Notes |
|---|---|---|---|
| ASV vulnerability scan | Quarterly (PCI DSS requirement — every 90 days) | $1,500–$6,000/year for a small external footprint | Must be a PCI SSC-**Approved** Scanning Vendor specifically — a generic vulnerability scanner/report doesn't satisfy Req 11.3.2. Cost scales with the number of externally-facing IPs/domains in scope rather than application complexity. |
| Penetration test | Annually, minimum — **also** required after any *significant* infrastructure/application change (a new external-facing service, a major architecture change) | $8,000–$30,000+ per engagement | Scope (network + application layers both, per PCI DSS Req 11.4) and depth (a checklist scan vs. a real manual assessment) drive cost more than company size. A payment API's authentication/authorization/business-logic surface (this repo's HMAC signing, idempotency, delegation spend policies) needs a tester who reads the app, beyond just running a scanner. |
| SOC 2 Type II audit | Annually (report refresh) | $15,000–$60,000+ per year | Scope (which Trust Service Criteria selected above) and control maturity drive cost — more automated evidence collection (vs. manual screenshots) lowers audit *hours* rather than the underlying scope. |

**Total rough annual recurring compliance spend once both programs are
running**: on the order of **$25,000–$100,000+/year**, before any
consulting/preparation cost to close the technical gaps first. Get
quotes from actual vendors before budgeting a real number — the ranges
above are for planning-stage sizing rather than a quote.

**What doesn't wait for a full QSA/SOC 2 engagement**: an ASV scan and a
first penetration test can both be scheduled *now*, independent of
whether formal certification is pursued — real external-facing findings
are useful regardless of audit status, and having at least one real
pentest report on file is itself often what a security-conscious
customer's vendor review asks for, short of a full SOC 2 report.

## 1099-K information-return reporting

A different kind of compliance deadline from SOC 2/PCI DSS above —
not a certification a third-party auditor grants, but a real annual
US tax filing obligation with its own real penalties for missing it.
In the US, a payment processor settling more than a statutory
threshold amount to a merchant in a calendar year must file a 1099-K
information return with the IRS and furnish a copy to the merchant.
Grouped here as another "modeled but not a substitute for the real
thing" item, alongside SOC 2/PCI DSS above.

`TaxForm1099KService` computes, for every merchant with `country` set
to `US`, an annual illustrative 1099-K: Box 1a (gross amount, **not**
reduced by refunds/chargebacks — the real IRS rule), a transaction
count, and a Box 5a-5l monthly breakdown — reusing
[`ledger-accounting.md`](../business-domain/ledger-accounting.md)'s
merchant-statement machinery (`MerchantStatementService.computeBreakdowns()`)
rather than re-deriving ledger-walking logic, since Box 1a's "gross
amount of reportable payment transactions" is the same real number a
merchant statement's own `grossVolume` already reconstructs.

**This is never actually filed with the IRS.** Unlike
`MatchReportingPort` (a real external integration this codebase
chooses to mock end-to-end), there is deliberately no IRS-filing port
or submission lifecycle here — an annual information-return filing is
exactly the kind of real compliance deadline this project should be
upfront about not actually submitting anything for, rather than
inventing a fake confirmation number that would read as more real
than it is. `reportable` (computed gross ≥ threshold) is as far as
this goes; a merchant/operator can view the computed result
(`GET /tax-forms/1099k`, `GET /admin/merchants/:id/tax-forms/1099k`)
but there's no "file this" action to call.

**The threshold is real, but has moved through a multi-year IRS
phase-in** — the American Rescue Plan Act (2021) set the eventual
threshold at $600 with no transaction-count minimum, but the IRS
granted transition relief that phased it in gradually: $20,000/200
transactions for 2023 (Notice 2023-74), $5,000 for 2024 (Notice
2024-85), an anticipated $2,500 for 2025, and the full $600 statutory
threshold from 2026 onward. Configurable via `IRS_1099K_THRESHOLD_USD`
(default `600`) rather than hardcoded, specifically so modeling an
earlier tax year doesn't require a code change — confirm the real
figure for whatever year this gets used against before treating the
default as authoritative.

**`MerchantEntity.country` is new, and intentionally separate from
`kybCountry`** (see [`merchants.md`](../business-domain/merchants.md)) —
KYB is CONNECTED-only, so a `PLATFORM` merchant (the common case)
would otherwise have no jurisdiction field at all to gate this
against. `country` left unset is excluded from the annual sweep
entirely rather than assumed non-US.

**Known simplification: one form per merchant per year, in whichever
currency had the largest volume.** A real 1099-K is a single
USD-denominated form; this codebase has no real historical FX-rate
reconstruction to correctly consolidate a merchant's multi-currency
activity into one figure for a past year, so a merchant with genuine
multi-currency activity gets the other currencies logged as an
explicit, visible gap (`TaxForm1099KService`'s own warning log) rather
than silently dropped or incorrectly summed across currencies.
