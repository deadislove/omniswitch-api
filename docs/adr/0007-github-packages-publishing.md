# ADR-0007: Publish sdk/node, sdk/java, and sdk/dotnet to GitHub Packages

## Status

Accepted

## Context

ADR-0005 and ADR-0006 both deliberately left "publish anywhere" as a
distinct, not-yet-made decision — every client SDK lived in this
repository only, built from source. `sdk-package.yml` (a separate,
earlier addition) builds and packages all six SDKs on every push to
`main`, but only as disposable GitHub Actions workflow artifacts (90-day
retention, not installable via any package manager) — deliberately
short of an actual publish, so a build failure would surface immediately
without committing to a registry presence.

Actually publishing removes the "copy the package out of this repo by
hand" step for a real integrator, at the cost of taking on everything a
real publish implies: a version can't be silently overwritten once
pushed, and consumers now depend on this registry staying available and
this repo's maintainers keeping the package's contract stable across
versions.

## Decision

Publish exactly three of the six SDKs — `sdk/node`, `sdk/java`,
`sdk/dotnet` — to **this repository's own GitHub Packages registries**,
never to the public npm registry, Maven Central, or NuGet.org. A new
workflow, `sdk-publish.yml`, does this; `sdk-package.yml` is unchanged
and keeps building disposable artifacts on every push.

**Why only three, not all six**: GitHub Packages has no native registry
format for Python (PyPI-compatible) or Rust (crates.io-compatible) —
publishing those would mean the public PyPI/crates.io instead, a
materially bigger commitment (a truly public, third-party-hosted
namespace) this ADR doesn't make. Go modules don't need a package-
registry publish step at all — `go get` resolves directly against a
tagged git commit, so `sdk/go` is already "published" in the way Go
modules work, the moment a tag exists.

**Trigger: a `sdk-v*` tag, not every push to `main`.** Unlike
`sdk-package.yml`'s disposable artifacts, a package version is a
one-way action on every registry involved here — GitHub Packages (like
npm, Maven Central, and NuGet.org) refuses to let a version be
re-published once it exists. Publishing on every push would mean every
commit after the first attempts to re-publish the same unchanged
version and fails. A maintainer bumps the version in each package's own
manifest (`package.json`/`pom.xml`/`OmniSwitch.Sdk.csproj`) when ready
to cut a release, then pushes a `sdk-v*` tag (e.g. `sdk-v0.1.0`) to
trigger the actual publish — an explicit, deliberate act, not an
automatic side effect of merging to `main`.

**`@omniswitch/node` renamed to `@deadislove/omniswitch-node`.** GitHub
Packages' npm registry requires a scoped package's namespace to match
the GitHub org/user that owns the repository — `@omniswitch` doesn't
match this repository's owner (`deadislove`), and would be rejected at
publish time. `sdk/java`'s Maven coordinates (`io.omniswitch:omniswitch-sdk`)
and `sdk/dotnet`'s NuGet package id (`OmniSwitch.Sdk`) have no
equivalent constraint — GitHub Packages associates those with a
repository via `pom.xml`'s `<distributionManagement>` and the publish-
time NuGet source URL respectively, not via a naming convention — so
neither needed to change.

**Credentials**: each job uses the workflow-run's own `secrets.GITHUB_TOKEN`
(scoped to this repository, expires with the run) with a job-level
`packages: write` permission — no long-lived personal access token
stored as a secret.

## Consequences

**What this buys**: `npm install @deadislove/omniswitch-node`,
`mvn`/Gradle dependency resolution against
`https://maven.pkg.github.com/deadislove/omniswitch-api`, and
`dotnet add package OmniSwitch.Sdk --source https://nuget.pkg.github.com/deadislove/index.json`
all become real for anyone with read access to this repository (GitHub
Packages inherits the repository's own visibility/permission model —
this is a public repository, so these are publicly installable, not
gated behind an org membership).

**What this costs**: three registries' worth of "don't break a published
version" discipline now applies. A mistake shipped in `sdk-v0.1.0`
can't be un-published and corrected in place — it needs a new version.
The manual "bump the version, then tag" release step is also a real
process a maintainer has to remember and do correctly; nothing in this
repository automates deciding *when* a version bump is warranted.

**Python, Rust, and Go remain workflow-artifact-only** (`sdk-package.yml`)
or tag-only (`sdk/go`) — not a gap introduced by this ADR, but worth
restating so "some SDKs are on GitHub Packages" isn't read as "all SDKs
are equally distributable today."

## Alternatives considered

- **Publish all six SDKs, sending Python/Rust to the real PyPI/crates.io
  instead of GitHub Packages**: rejected for this pass — a public,
  third-party-hosted namespace is a bigger, more permanent commitment
  (a name on PyPI/crates.io that can't easily be reclaimed or renamed)
  than a GitHub-Packages-hosted package tied to this repository's own
  lifecycle. Worth revisiting per-language if real demand for those two
  specifically shows up.
- **Publish on every push to `main`, with an auto-incrementing
  pre-release version** (e.g. `0.1.0-main.<sha>`): would remove the
  manual "bump and tag" step, but trades it for a constant stream of
  throwaway pre-release versions on a real, permanent registry —
  rejected as noisier than the tag-triggered model for a package with
  no real consumers yet to signal "this specific version is the one to
  use."
- **A long-lived personal access token instead of the per-run
  `GITHUB_TOKEN`**: rejected — a PAT stored as a repository secret
  outlives any single workflow run, is scoped by whatever the token
  creator's own permissions allow (broader than this one repository, by
  default), and has to be manually rotated; the per-run token requires
  none of that and is already scoped to exactly this repository.
