# Contributing to Breatic

Thanks for your interest in contributing to Breatic! This document covers
the policies and workflows you need to know before opening a pull request.

## Code of Conduct

Be kind. Be technical. Assume good intent. Disagree with ideas, not people.

## Getting Started

1. Fork the repository and clone your fork.
2. Create a feature branch from `main`: `git checkout -b feat/your-feature`.
3. Install dependencies: `pnpm install`.
4. Copy environment template: `cp .env.dev .env` and fill in the values
   you need (see [docs/DEPLOY.md](./docs/DEPLOY.md) for reference).
5. Run `pnpm typecheck` and `pnpm test` before committing.
6. Open a pull request targeting `main`.

See [docs/DEPLOY.md](./docs/DEPLOY.md) for full local development setup (Docker, DB,
Redis, etc.) and [README.md](./README.md) for architecture overview.

---

## Commit author / trailer policy

Commit `Author:`, `Committer:`, `Co-Authored-By:`, and `Signed-off-by:`
fields must identify human contributors only. Automated tooling cannot
grant copyright; listing such tooling in these fields creates licensing
ambiguity, since the Breatic Open Source License depends on identifiable
human authors being able to grant rights.

Enforcement is automatic:

- `.husky/commit-msg` rejects offending trailers locally (activated by
  `pnpm install` via the `prepare` script).
- `.github/workflows/no-ai-attribution.yml` runs on every PR targeting
  `main` and scans both commit trailers and the Git author name/email
  of every commit in the range. A failing check blocks the merge.

If CI rejects your PR, rewrite the offending commits:

```bash
# Trailer issue
git rebase -i <base-sha>   # mark commit as 'reword', remove the trailer
# Author issue
git rebase -i <base-sha>   # mark commit as 'edit'
git commit --amend --author="Your Name <you@example.com>"
git rebase --continue
git push --force-with-lease
```

Discussing tooling assistance in PR descriptions or commit bodies is
fine — only the authorship *identity* fields are restricted.

---

## Commit Message Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Examples:

```
feat(canvas): add node history API
fix(worker): handle null result from WaveSpeed
docs: update ROADMAP with completed tasks
chore(ci): bump pnpm to 9.15.0
```

Keep the subject line under 72 characters. Use the body to explain
*why*, not *what* (the diff already shows what).

---

## Soft Delete Policy (MANDATORY)

**All database delete operations must be soft deletes.** Breatic is a
creator platform — user content is a primary asset. Hard-deleting
creates permanent data loss that cannot be recovered even by support.

### Rules

- Every table that can be user-deleted has a `deleted_at: timestamp` column.
- `list` / `get` queries filter `deleted_at IS NULL` by default.
- Repo layer exposes `softDelete(id)` instead of raw `db.delete()`.
- Soft delete **does not** clean up associated files in OSS / S3 / local
  storage. Files are retained indefinitely.
- Exceptions (GDPR account deletion, regulatory cleanup) are handled by
  a separate administrative flow, not the regular code path.

If a feature needs to "delete" something, use soft delete. If you
genuinely need hard delete, open an issue for discussion first.

---

## Code Style

- **TypeScript strict**. No `any` — use `unknown` and narrow it.
- **TSDoc** (`@param`, `@returns`, `@throws`, `@example`) for every
  exported public API.
- **Small files > large files**. 200–400 lines typical, 800 max.
- **Immutability by default**. Prefer new objects over mutation.
- **Error handling at every layer**. No bare `catch` — either handle
  specifically or re-throw.

See [CLAUDE.md](./CLAUDE.md) for the full project specification.

---

## Pull Request Process

1. Ensure `pnpm typecheck && pnpm lint && pnpm test` pass locally.
2. Open a PR targeting `main` with a clear description of the change.
3. Link any related issues.
4. Respond to review feedback within a reasonable time.
5. Once approved and CI is green, a maintainer will merge it.

CI runs on every PR. The required checks:

- `lint-typecheck-test` — lint, typecheck, unit tests
- `docker` — Docker image builds
- `check-authorship` — no AI author/co-author (see above)

All three must pass before merging.

---

## Reporting Issues

Use [GitHub Issues](https://github.com/orime-org/breatic/issues) with
a clear title, reproduction steps, and environment info. For security
issues, email the maintainers privately instead of opening a public issue.

---

## License

By contributing, you agree that your contributions will be licensed under
the same license as the project (see [LICENSE](./LICENSE)).
