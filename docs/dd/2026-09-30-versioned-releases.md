# Versioned release mechanism — 2026-09-30

## Scope and user decision

The user approved tag-triggered builds with version metadata in frontend/backend artifacts, automatic image upload, and separately controlled deployment. This is a deployment architecture change within that request. No application authentication, UI, schema or CRDT behavior changes.

## Candidates and comparison

| Candidate | Evidence / fit | Decision |
|---|---|---|
| Existing main/latest publication | Previous ci.yml pushes branch aliases on every main merge; aliases do not identify a deployment batch | Remove publication on branch pushes, retain build checks |
| Per-release package.json PR | Root and application package.json currently say 0.1.0; changing these creates source churn without pinning registry artifacts | Keep internal package versions, inject release metadata |
| Tag build using existing GitHub Actions + GHCR | Existing CI already listens to v* and builds both Dockerfiles | Chosen, exact full tag plus digest manifest |
| Relabel an earlier branch image | Earlier workflow does not publish a manifest tying both images to a verified SHA; cannot establish an existing trusted release pair | Not used for this transition |
| Manual workstation image upload | inner build-image.sh can do this; machine setup and operator work become part of every release | Keep unrelated backoffice workflow; backend uses CI |
| External release service or new dependency | No external service required for existing GitHub/GHCR workflow | No new dependency or service |

## Due diligence evidence

- Runtime checks: scripts/release.test.mjs validates identity and digest manifest; CI reads metadata from real backend/web images before publishing. Inner tests cover source drift, mismatched digest, wrong embedded version and migration failure.
- Source: changes remain in existing ci.yml, Dockerfiles, Vite build configuration and inner deployment scripts. Metadata generation uses Node standard library; release selection uses Python standard library and the existing GitHub CLI.
- Governance/licence: existing Docker/GitHub Actions and GHCR integration retained; no library adoption or vendored code.
- Security: release publication uses the repository GITHUB_TOKEN, only in tag steps. Build metadata is public and contains no runtime secrets. Checkout and local source selection do not import private backend env files.
- Upstream contract: locally inspected `gh release create --help` / `edit --help`: draft, verify-tag, publish and attachment support. Existing Docker actions remain at their repository-selected versions.

## Invariants and failure handling

A complete release maps one tag to one commit and backend/web digests. All required CI jobs and image checks precede publication. Reserving a draft precedes the first registry push; existing drafts/releases stop reruns. Incomplete drafts cannot be selected for deployment. Releasing does not deploy production. Test/production promotion uses identical digests, not a rebuild.

No distributed custom lifecycle is introduced: GitHub's draft/published release status represents publication completion. Operators protect release tags and retain referenced images. Failed reserved versions require a new tag. Frontend update identity stays the commit SHA; readable releaseVersion is additive.

## Acceptance plan

- [x] Metadata unit tests, static lint/typecheck and real frontend build.
- [ ] Docker artifact verification or explicitly record an external build blocker.
- [x] Inner selection, packaging, deployment failure and existing frontend routing regression tests.
- [x] Update deployment docs and open reviewable PRs; do not tag or deploy production in this change.

Local evidence: actual Vite build and web typecheck passed; metadata CLI tests (5), update-hook tests (17), repo checks (32), inner Python tests and Worker route tests passed. A real nginx container returned the generated version JSON with HTTP 200 and no-store. Full Docker build/CI results are recorded on PR #628; no release tag or publication is exercised by this PR.
