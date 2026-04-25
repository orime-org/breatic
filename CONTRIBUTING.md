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

## ⚠️ AI Authorship Policy (MANDATORY)

Breatic is an open-source project. Under current **US copyright law**
(see the [U.S. Copyright Office report on AI, Part 2 (2025)](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf)),
purely AI-generated content is not copyrightable. Listing an AI tool as
the author or co-author of a commit creates **licensing ambiguity** —
the Breatic Open Source License (like any license) depends on
identifiable human authors being able to grant rights. An "AI
contributor" cannot grant anything.

### What is NOT allowed

The following fields **must never reference an AI tool** (Claude,
Anthropic, ChatGPT, GPT, OpenAI, Copilot, Cursor, Codex, etc.):

- `Author:` — the primary author of a commit
- `Committer:` — who committed the change
- `Co-Authored-By:` — trailer line in the commit message
- `Signed-off-by:` — trailer line in the commit message

Concretely, **never** let this end up in your commit message:

```
Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Codex <codex@openai.com>
Signed-off-by: GitHub Copilot <...>
```

### What IS allowed

- **Describing AI assistance in the commit body or PR description.**
  Saying "used Claude to draft the initial regex" or "Copilot-assisted
  refactor" is perfectly fine. We only restrict authorship *identity*,
  not transparency about tooling.
- Using any AI tool to help you write, review, or refactor code. The
  output becomes *your* contribution once you review, adapt, and take
  responsibility for it.

### Why the distinction matters

Copyright attaches to authored work. A human who reviews, edits, and
commits code is the author — they made creative choices and assume
legal responsibility. The AI tool is an instrument, like a compiler or
an IDE. You wouldn't list `tsc` as a co-author; don't list Claude either.

### Enforcement

Two layers prevent violations:

1. **Client-side hook** — `.husky/commit-msg` blocks any commit whose
   message contains an AI-attributed `Co-Authored-By:` or `Signed-off-by:`
   trailer. The hook is activated automatically by `pnpm install` (via
   `prepare` script setting `core.hooksPath=.husky`).
2. **Server-side CI** — `.github/workflows/no-ai-attribution.yml` runs
   on every PR targeting `main`. It scans both the commit trailers *and*
   the Git author name/email of every commit in the PR range. Failing
   this check blocks the merge.

If CI rejects your PR for this reason, you need to rewrite the offending
commits:

```bash
# For a trailer issue
git rebase -i <base-sha>
# Mark the commit as 'reword', remove the Co-Authored-By line, save

# For an author issue
git rebase -i <base-sha>
# Mark the commit as 'edit'
git commit --amend --author="Your Name <you@example.com>"
git rebase --continue

git push --force-with-lease
```

### Tool-specific notes

If you use a tool that auto-inserts AI attribution:

- **Claude Code**: Configure it to skip the trailer. In `~/.claude/settings.json`,
  ensure co-author attribution is disabled.
- **GitHub Copilot**: Copilot doesn't add trailers by default. Safe.
- **Cursor**: Check your commit template settings.
- **Any other tool**: Inspect the commit message template before pushing.

### Historical Context

Before this policy was put in place, some PRs in this repository
contained `Co-Authored-By: Claude` trailers in their commit history.
These trailers exist only in GitHub's read-only PR references
(`refs/pull/N/head`) and **were never merged into the `main` branch**:
all PRs are squashed on merge, producing a single human-authored
commit per merged change.

The `main` branch — the authoritative publication history — has never
contained AI-author attribution. Automated checks now block any such
trailers from entering new commits.

Copyright over project code remains with the human contributors
identified in `git log` and the [LICENSE](./LICENSE). Tooling assistance
during development does not affect that attribution.

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

Use [GitHub Issues](https://github.com/orime-org/breatic_ai/issues) with
a clear title, reproduction steps, and environment info. For security
issues, email the maintainers privately instead of opening a public issue.

---

## License

By contributing, you agree that your contributions will be licensed under
the same license as the project (see [LICENSE](./LICENSE)).
