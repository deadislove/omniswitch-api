# Contributing

## The short version

This is a personal reference/portfolio project, licensed
**All Rights Reserved** (see [`LICENSE`](./LICENSE)) — it isn't set up
to accept external code contributions the way a typical open-source
project is, and pull requests adding features or refactoring existing
code will generally not be merged. That's a deliberate choice about
this specific project, not a comment on the idea of open source.

What **is** genuinely welcome:

- **Issues** — bug reports, questions about a design decision, or
  pointing out something incorrect/stale in the documentation. This
  project takes its own "no leftover documentation debt" standard
  seriously (see [`DEV_README.md`](./DEV_README.md)'s development
  history for how thoroughly each round of changes gets verified and
  documented) — a report that something's out of date is useful.
- **Discussion** — if you're studying this codebase (e.g. to learn
  Hexagonal Architecture/DDD patterns, or how a payment gateway's ledger
  should work) and have a question, open an issue. Explaining the
  reasoning behind a design decision is exactly what
  [`docs/guide/`](./docs/guide/) is for, and a good question is a sign
  the docs should probably say that explicitly.

## Before you open an issue

Please check whether it's already answered:

- [`docs/guide/`](./docs/guide/) — start here for onboarding: the
  business-domain guide, system design doc, and full API reference.
- [`README.md`'s Known Limitations](./README.md#known-limitations) and
  [`docs/business-domain/future-directions.md`](./docs/business-domain/future-directions.md) —
  the current, honest list of what's illustrative/uncalibrated/out of
  scope. If your question is "why doesn't X do Y properly," it's very
  likely already answered here.
- [`DEV_README.md`](./DEV_README.md) — the technical development log:
  what was built in each round, real bugs found along the way, and how
  each change was verified.

## If you want to run this yourself

See [`README.md`'s Quick Start](./README.md#quick-start) section for
local setup (Docker Compose, migrations, bootstrapping an admin
merchant) and [`docs/guide/system-design.md`](./docs/guide/system-design.md#7-testing-strategy)
for how the test suite works. Nothing here requires special access —
the whole stack (Postgres, Redis, Vault, a mock PSP server) runs
locally via Docker.

## Reporting a security issue

Don't open a public issue for a security vulnerability — see
[`SECURITY.md`](./SECURITY.md) for how to report one privately.
