# Compliance

This folder covers compliance areas that are about *how long data is
kept and what happens to it over time* — distinct from
[`../technical/security-and-compliance.md`](../technical/security-and-compliance.md),
which covers JWT revocation design and PCI DSS scope/gaps (protecting
data while it's live, not what happens to it as it ages).

## What's here

- [`data-retention.md`](./data-retention.md) — this project's AML
  (anti-money-laundering) record-keeping approach: what gets kept, for
  how long, what "archived" vs "deleted" actually means here, how the
  scheduled jobs that enforce this work, and — most importantly for
  anyone deploying this somewhere real — **how to configure the
  retention periods for a specific jurisdiction**, since this is a POC
  meant to be adaptable, not a one-size-fits-all compliance product. Its
  ["Jurisdictional compliance review checklist"](./data-retention.md#jurisdictional-compliance-review-checklist)
  section is the concrete starting point for that review — what to
  confirm, not an answer key.

## The honest scope of this folder

This project is a reference implementation, not a certified compliance
system. AML record-keeping requirements are set by each jurisdiction's
own regulator (differ by country, and sometimes by transaction type
within a country) — nothing in this repo has been reviewed by legal or
compliance counsel for any specific jurisdiction. `data-retention.md`
documents a real, working mechanism with sensible, commonly-seen
defaults (180-day hot-to-cold archive threshold, 8-year deletion
threshold) — but those specific numbers, and whether "export to a local
JSON file then delete" is an acceptable deletion mechanism at all, are
exactly the kind of thing a real deployment needs its own compliance
review to confirm before relying on this in production. See
`data-retention.md`'s own "What this doesn't cover" section for the
specific gaps.
