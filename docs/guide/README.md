# New Engineer Guide

Start here. This folder is the onboarding path for someone joining the
team — read these in order and you'll have a working mental model of
both *what this system does* and *how it's built* before you write your
first line of code against it. The rest of [`docs/`](../) is the deeper
reference you'll come back to once you're working on a specific area.

## Reading order

1. **[`business-domain-guide.md`](./business-domain-guide.md)** — what
   this system actually does, in payments-industry terms: payments,
   ledger accounting, subscriptions, marketplace splits, disputes, risk
   reserves, cross-border settlement, agentic payments. Read this first,
   even before looking at any code — the code makes a lot more sense
   once you know *why* it's shaped this way.
2. **[`system-design.md`](./system-design.md)** — how the above is
   actually built: the hexagonal-architecture module structure, a
   charge's full request lifecycle, cross-cutting infrastructure
   concerns (multi-replica state, JWT revocation, idempotency), and —
   importantly — a checklist for making a change safely (adding a field,
   adding a whole new aggregate, adding a money-moving endpoint).
3. **[`api/README.md`](./api/README.md)** — the actual HTTP surface:
   every endpoint, auth/HMAC/idempotency conventions, error format. Skim
   the whole thing once, then use it as a reference per-endpoint as
   needed. The API is also live and interactive at `/api/docs` (Swagger
   UI) once the app is running.

## Operating the background jobs

Not part of the onboarding reading order above, but worth knowing this
exists once you're actually deploying or operating this system:
[`jobs/`](./jobs/) is a runbook for the archiving, deletion, partition
maintenance, and cutover-cleanup jobs — how to run each one manually,
read its logs, and troubleshoot a failure. The policy/design behind
what these jobs do lives in
[`../compliance/data-retention.md`](../compliance/data-retention.md)
and [`../technical/jobs.md`](../technical/jobs.md); this folder is
specifically the "how do I run this" reference.

## Getting the app running

The top-level [`README.md`](../../README.md)'s "Quick Start" section is
the actual step-by-step (install, migrate, bootstrap an admin merchant,
run). Come back to that once you've read the three docs above and want
to actually poke at the running system.

## If you get stuck on "why does this work this way"

Check these, roughly in order of how likely they are to have the answer:

- **[`../business-domain/future-directions.md`](../business-domain/future-directions.md)**
  and the top-level README's
  **["Known Limitations"](../../README.md#known-limitations)** section
  — if something feels intentionally simplified or not fully built out,
  it's almost certainly documented here, with the reasoning.
- **[`../../DEV_README.md`](../../DEV_README.md)** — the development
  roadmap and changelog: what was broken, what a real bug looked like
  when it was found, how each feature was verified. This is the place
  for "why was this built this specific way" and "what did we learn
  building it," organized by feature/round rather than by domain
  concept.
- **[`../technical/`](../technical/)** — deep dives on specific
  cross-cutting technical concerns (JWT revocation trade-offs, PCI DSS
  posture, secret management, distributed state, database migrations,
  reconciliation, load testing) that are too detailed to fit in
  `system-design.md` but that you'll want the full story on before
  touching that area.
- **[`../business-domain/glossary.md`](../business-domain/glossary.md)**
  — quick lookup for a term used in the code that doesn't mean quite
  what you'd assume from outside this codebase.

## Keeping this guide accurate

If you change something this guide describes (an endpoint's shape, a
domain rule, a module's responsibility), update the relevant doc in the
same change — a wrong guide is worse than no guide, since new engineers
will trust it. Run the project's markdown link-checker after editing
anything under `docs/` to catch broken cross-references before they
land.
