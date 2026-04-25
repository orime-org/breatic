# Git Worktree Workflow (optional)

This document describes an **optional** parallel development setup using
`git worktree`. You don't need this to contribute — the standard clone +
branch + PR workflow in [CONTRIBUTING.md](../CONTRIBUTING.md) works fine.

Use worktrees when you want to:
- Run multiple coding sessions in parallel on different branches.
- Keep a long-running experiment in one directory while fixing a bug in another.
- Drive multiple AI coding agents on different tasks simultaneously.

---

## How it works

A worktree is a second working directory backed by the same `.git`
metadata. Each worktree has its own files and can be checked out to a
different branch, but they all share the same commit history and branches.

```
breatic/                          # Primary worktree (usually on main)
├── .git/                         # Single source of git metadata
├── packages/...
└── worktrees/                    # Git-ignored; add any new worktrees here
    ├── feat-yjs-sync/            # Worktree 1, checked out on feat/yjs-sync
    │   ├── .git                  # Pointer to ../../.git
    │   └── packages/...
    └── fix-something/            # Worktree 2, checked out on fix/something
```

`worktrees/` is in `.gitignore` so its contents never show up in the
primary worktree's `git status`.

---

## Creating a worktree

```bash
# From the primary worktree root
git worktree add worktrees/feat-yjs-sync -b feat/yjs-sync main

cd worktrees/feat-yjs-sync

# Share environment variables from the primary worktree (see "Env vars" below)
ln -s ../../.env .env

# Install node_modules — each worktree has its own
pnpm install
```

You're now ready to run `pnpm typecheck`, `pnpm test`, `pnpm lint`,
or open the directory in a new editor / AI agent.

---

## Env vars

The backend reads `.env` from the **worktree's** monorepo root (via
`MONOREPO_ROOT` in `packages/server/src/config/env.ts`), and Vite does
the same (via `envDir` in `packages/web/vite.config.ts`). This means
every worktree needs its own `.env` file present.

**Recommended**: symlink the primary `.env` into each worktree.

```bash
cd worktrees/feat-yjs-sync
ln -s ../../.env .env
```

Pros:
- Change a key once in the primary `.env`, all worktrees pick it up.
- No risk of drift between copies.
- The pre-commit hook still catches accidental `.env` commits in any
  worktree (the file name is still `.env`).

**Exception**: if you want a worktree to run its own dev server on a
different port (see "Running dev servers" below), copy the file instead
of symlinking so you can override `PORT` and `COLLAB_PORT`.

```bash
cd worktrees/feat-yjs-sync
cp ../../.env .env
# Edit PORT=3001, COLLAB_PORT=1235, ...
```

---

## Running dev servers

Running `pnpm dev` / `pnpm dev:collab` / `pnpm dev:worker` binds ports
`3000` / `1234`. Two worktrees running dev servers at the same time will
conflict on those ports.

**Easiest rule**: only one worktree runs dev servers at a time. Use
other worktrees for static work (typecheck, test, refactor, docs, commit,
PR creation — none of which need a running server).

**If you really need two dev servers at once**, give the second worktree
its own copied `.env` (as above) and set different ports. Also give it
its own Redis key prefix by changing `ENV`:

```bash
# In worktrees/feat-yjs-sync/.env
ENV=dev-feat-yjs-sync            # Isolates Redis keys
PORT=3001
COLLAB_PORT=1235
```

Database and Redis are shared across worktrees by default — this is
intentional so you can test multi-user / multi-session scenarios. If
you need hard DB isolation, create a separate database and point that
worktree's `DATABASE_URL` at it.

---

## Switching between worktrees

```bash
git worktree list           # Shows all worktrees
cd worktrees/feat-yjs-sync  # Switch directory
```

Each editor / AI agent can open a different worktree path, so there's
no "switching" inside an editor — just open the folder you want.

---

## Merging worktree work

Worktrees share commits. When you push the branch from a worktree and
open a PR, the PR shows up normally on GitHub. No special steps.

```bash
cd worktrees/feat-yjs-sync
git push -u origin feat/yjs-sync
gh pr create ...
```

---

## Cleaning up

After a PR is merged (or abandoned), remove the worktree:

```bash
# From anywhere
git worktree remove worktrees/feat-yjs-sync
git branch -D feat/yjs-sync          # If the branch is no longer needed
```

If the worktree directory has uncommitted changes and you really want to
force-remove it:

```bash
git worktree remove --force worktrees/feat-yjs-sync
```

To list and prune stale worktree entries (e.g. after a manual deletion):

```bash
git worktree list
git worktree prune
```

---

## Common gotchas

| Issue | Fix |
|-------|-----|
| `.env` not loading | Make sure `.env` exists inside the worktree (symlink or copy). |
| `node_modules` resolution errors | Run `pnpm install` inside the worktree. Each worktree has its own. |
| Port already in use | Only run dev servers in one worktree at a time, or override `PORT` / `COLLAB_PORT` in `.env`. |
| Redis key collisions | Change `ENV` in the worktree's `.env` to get a different key prefix. |
| Shared DB state causing test flakiness | Use unique seed data per worktree, or create a separate database. |
| Worktree directory looks orphaned after `rm -rf` | `git worktree prune` cleans up stale metadata. |
| Git hooks not running | `core.hooksPath=.husky` is set by the `prepare` script; run `pnpm install` in the worktree. |

---

## Example: running 2 parallel coding sessions

```bash
# Primary worktree: main branch
cd ~/code/breatic
# ... one editor / AI agent here, doing PR review or docs

# Session 2: feature branch in a worktree
git worktree add worktrees/feat-awareness -b feat/awareness main
cd worktrees/feat-awareness
ln -s ../../.env .env
pnpm install
# ... second editor / AI agent here, implementing the feature

# Both sessions can commit, push, and open PRs independently.
# They share .git, so branches and remotes are visible from both.
```
