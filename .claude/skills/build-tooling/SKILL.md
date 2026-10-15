---
name: build-tooling
description: Use before changing build or test configuration in breatic (turbo.json, tsup, vite, vitest, tsconfig paths, package.json scripts or dependencies, Dockerfiles, CI workflows), before adding or reorganising a workspace package, when a local typecheck, build or test fails in a way that does not match the change, and before writing an ESLint rule or a repo-lint check.
---

# Build tooling, tests and guards

Writing an ESLint rule or a repo-lint check: read [guards.md](guards.md) first.

## Builds and the package graph

**A `--filter` build or dev run skips the dependency builds that turbo would run first.** Libraries are consumed through `exports.import`, which points at `./dist`.

| Command | What goes wrong |
|---|---|
| `pnpm --filter @breatic/web build` | Runs `vite build` alone, against the old `shared/dist`: a new shared export never reaches the bundle and `verify:chunks` passes falsely. A running root `pnpm dev` rebuilds `dist` in the background and hides this on your machine |
| `pnpm --filter @breatic/server dev` (and root `dev:server`, `dev:worker`, `dev:collab`) | Starts `tsx watch` on the service alone, against the old `domain`/`core`/`shared` `dist`; edits to those packages never load |

Build first (`pnpm build`, or `pnpm build --filter=@breatic/<pkg>...`) or use root `pnpm dev`. A command written into a doc for others to copy must include that build step.

Check: is the code I changed in a different package from the one I am building or starting?

**After restructuring one package, search the whole repository for deep imports into it and run the full `pnpm typecheck`.** Another package importing a moved path breaks, and typechecking only the package you moved stays green while CI goes red.

**A tsconfig path alias can be live with zero uses in its own package.** `shared`, `core` and `domain` point `exports.types` at their `src`, so a consumer's TypeScript reads the dependency's source and meets that package's internal aliases; `integration-tests` reaches the `server`, `worker` and `collab` source through `@server/*`, `@worker/*`, `@collab/*`. Web's tsconfig keeps `@shared/*` although `packages/web/src` never writes it. Whether an alias is dead depends on which packages can reach that source through the dependency graph; a search with zero hits is only the first condition.

**Restart `pnpm dev` after changing tsup, vite or tsconfig configuration.** The running watchers keep building with the old configuration.

**tsup, vite and vitest only transpile; types are checked only by `pnpm typecheck`.** CI runs `pnpm turbo typecheck`, which reaches a package only through its own `typecheck` script, so a new package without one is never typechecked.

**A new workspace library that a service imports must be added to the runtime stage of `Dockerfile`.** The runtime stage copies each library's `dist` and `package.json` by name, and the `sentry-cli sourcemaps inject` line lists each `dist`; the build stage copies the whole workspace and does not need it. A missing copy builds locally and fails only in the Docker job.

## Dependencies

**After changing any dependency, run a plain `pnpm install`, never one with `--filter`.** `pnpm install --filter <pkg>` and `pnpm --filter <pkg> add|remove <dep>` relink other packages' `node_modules`, for example pointing web's `vite` at another installed version, and typecheck then fails in files unrelated to the change while the lockfile diff looks clean.

Check: does the failing file have anything to do with my change? No → run a full `pnpm install` before concluding the code was already broken. To confirm, `ls -l packages/<pkg>/node_modules/<dep>` and compare the linked `.pnpm` version with the declared range.

**Before saying `main` is broken, check CI: `gh run list --branch main --limit 5`.** Green there means the failure is local. `pnpm install` reports nothing to do while `node_modules/.pnpm` still holds an older copy of a package next to the current one, and the older `.d.ts` can lack a new export; delete the `node_modules` directories and install again.

Check: have I seen this error happen on CI?

**When vitest reports that a `vi.mock` factory references top-level variables, read the `Caused by:` line; the first message is a generic template.** The cause is often that the mocked module itself cannot load, typically because a dependency is missing locally (a `tsc: Cannot find module` at the same time points the same way). Two different errors appearing together are likely one cause.

Check: can the mocked module be imported on its own?

## turbo and environment variables

**Every environment variable a task reads must be listed in `globalPassThroughEnv` in `turbo.json`.** turbo runs tasks with a filtered environment; locally the services load `.env` themselves and hide the gap, and CI fails. When adding one, list every variable the code reads in the same change, found with a search such as `git grep -ohE 'process\.env\.[A-Z0-9_]+' | sort -u`, not only the one CI complained about.

## Vitest

**A package's `test` script is `vitest run`.** Bare `vitest` starts watch mode and turbo waits on it forever.

**Adding an alias to `packages/web/vite.config.mts` means adding the same alias to `packages/web/vitest.config.ts` in the same change.** The vitest config has its own `resolve.alias`; without the mirror every test importing through the alias fails with `Failed to resolve import`.

**A partial `vi.mock` must spread the real module.** The factory replaces the whole module, so any export it does not list becomes `undefined`, including exports added later.

```ts
vi.mock('@core/x', async (importOriginal) => ({ ...(await importOriginal<typeof import('@core/x')>()), fn: vi.fn() }));
```

**Each package runs all its test files in one process (`singleFork: true`), and `isolate` resets only module caches and mocks.** Within a package these survive from file to file:

| Shared state | Example |
|---|---|
| Module-level state of `node_modules` packages | ProseMirror names the second `new PluginKey('x')` `x$1`; Radix focus-guards keep a counter |
| Process singletons | React Query's `onlineManager` left offline |
| Stubbed globals | Web sets `unstubGlobals: true`; other packages do not |
| The jsdom document | Nodes appended by hand; `cleanup()` removes only what testing-library rendered |

Look plugins up by key object (`key.get(state)`), never by printed name. Resets of shared state belong in the package's global setup (`vitest.setup.ts`), never in a test body that a failure can skip.

Check: does this test change something that exists once per process and does not belong to this file?

**In `vitest.setup.ts`, run the resets that must always happen before any hygiene step that can throw.** One exception in an `afterEach` skips the lines after it for every later file in the package, not only the failing test.

**vitest 3.2.7 has no `list` reporter.** `--reporter=list` makes it look for a package named `list`, it runs no tests, and the exit looks like a finished run. Use one of vitest's own reporter names (`default`, `verbose`, `dot`, `json`).

## CI

**Renaming a job's `name:` in `.github/workflows/*.yml` can block every PR.** Branch protection matches required checks by job display name (`ci.yml` marks `Lint + Typecheck + Test` as the required one), and that list lives in the repository settings, not in any file. Before merging a rename, compare with:

```sh
gh api repos/<owner>/<repo>/branches/main/protection --jq '.required_status_checks.contexts[]'
```

If a renamed check is required, a maintainer must update the setting first and the PR merges after; in the other order, every later PR waits for a check that never reports.
