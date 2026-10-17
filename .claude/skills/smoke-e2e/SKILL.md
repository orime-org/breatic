---
name: smoke-e2e
description: Use before choosing, writing or running Playwright smoke or visual specs under packages/web/tests, before driving the real app in a browser (Playwright, Chrome DevTools, a one-off probe) to check how a product behaves, and when deciding whether a red smoke case belongs to the current change.
---

# Smoke, E2E and real-browser checks

**Read [docs/TEST-MANDATE.md](../../../docs/TEST-MANDATE.md) §2 and §3 before choosing, writing or running specs.** It defines what the suite prepares for itself, the `@needs-*` tags, which specs count as related to a change, the rules every spec follows, and how a red case is attributed. This skill holds what that document does not.

Driving the canvas, timing assertions and measuring geometry have their own traps: read [browser-traps.md](browser-traps.md) before writing a spec or probe that drags, clicks overlapping nodes, measures sizes, screenshots after a click, asserts that something stays hidden, or fakes an agent stream.

## Before a run: prove the target

**Prove the page under test is served by your own stack, running the code you just changed.** Health checks and SSE answer the same whether or not your change is loaded.

| Check | How |
|---|---|
| The listener is yours | `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`, then `ps -o pid,etime,command -p <pid>`: the command line must hold your worktree's path; for starting and reusing the stack, invoke `/dev-processes` ([SKILL.md](../dev-processes/SKILL.md#starting-the-stack)) |
| A library change is built | After editing `shared`, `core` or `domain` without root `pnpm dev` running, `pnpm build --filter=@breatic/<pkg>...`; then the listener's start time must be later than the build. An empty PID means it is restarting: wait for the new one |
| The browser loaded new code | A long-running dev server can serve `504 (Outdated Optimize Dep)` for modules after a merge, or render perfectly from code built before your change; restart `pnpm dev` before judging red or green |

Never probe a port with `/dev/tcp`: it is a bash pseudo-device, so under zsh the probe always fails and every port reads as free.

The cheapest proof that the change is live is a visible marker or a `console.log` at the changed line and one page load; it costs far less than a run of the spec.

Check: did what I observed come from a process I started, running the code I changed?

**When setup stops with "The app painted nothing", fix the environment before touching code.** Setup opens `/login` first and fails on an empty `#root` or a page error; after a branch switch the usual cause is a dependency's `dist` built from the other branch. Restart `pnpm dev`, rebuilding the library packages first.

**Run the suite through `pnpm --filter @breatic/web test:smoke` (or `test:visual`), not `playwright test` directly.** The script first runs `pnpm -w db:check-watermark` and then excludes `@needs-*` cases and prints what it left out; a bare `playwright test` does neither. Extra arguments are forwarded, so a case selection goes after the script name.

## Choosing what to run

**Select related cases with `file:line` when only some cases in a spec are related.** Running the whole file also runs its unrelated cases, and their failures then get mistaken for evidence. Write the file name alone only when every case in it reaches the change.

**Specs driven by a real model rarely reach a rejection or error branch.** A model that gets it right first time never exercises the refusal path, so running such a spec for a change to that path spends minutes and model calls and proves nothing.

**When the change sits after the model's answer (where a proposal lands, how a card renders), verify the flow with a spec that intercepts `**/chat/message`.** Several specs do this with `page.route('**/chat/message', …)`; a real-model case is related only when the change is on the path to that external service.

## Reading results

**Judge a run by the `N passed`, `N failed` and `N skipped` counts and by the coverage line the default run prints, never by the exit code or the last lines.** A run whose cases were skipped or excluded exits 0 and ends like a green one.

**Playwright prints the failure detail in the middle of its output, so `tail` cuts it off;** `test-results/<case>/error-context.md` holds the page snapshot at the moment of failure.

**For a red case with no matching record yet, search the open issues by the spec file name and again by words from the case title.** Issue titles often paraphrase the case, so a file-name search alone misses them. It counts as already filed only when both the case and the failure text match.

## Accounts and data

**The suite makes its own accounts, studios and Projects (docs §2.1); never register an account for a spec or point a spec at a personal one.**

**For hand-driven checks, register accounts through the UI and reuse them.** Multi-member flows (invites, transfers, members joining and leaving) need several: register a batch at once. Leave these accounts in the local dev database; they exist to be reused.

**Remove every Space you create outside the suite.** The suite's own are checked by teardown (docs §3), but a probe or one-off script does not run a spec's `afterEach`: call `deleteSpace` from `tests/helpers/space.ts` itself. Spaces made by hand are at least closed with the tab's close button (`space-tab-close-<id>`), which releases the document; deleting through the drawer also keeps the Project's Space count down. Collab caps writable connections per document (`packages/collab/src/services/connection-registry.ts`) and downgrades the excess to read-only, so leftovers make later cases fail on the read-only notice.

**`deleteSpace` only warns when it fails.** After a probe, search its output for `could not delete Space` or count the Spaces in the drawer.

**Keep the browser open for the whole of a hand-driven check.** Closing it after each step loses the state the next step and the reviewer need to see.

Check: did I create a Space this session, by script or by hand, and is it still there?

## Product behaviour needs the real browser

**A claim about what users see is settled in the real browser; reading code settles only what the code contains.** Product words and code symbols do not map one to one: a "loading on tab switch" can be `project-loading-screen`, which no search for "loading" in the tab code finds.

| To see | Do |
|---|---|
| UI that exists for tens of milliseconds | Register a `MutationObserver` through `page.addInitScript` before the page loads and record what appears |
| What actually covers a point | `document.elementFromPoint(x, y)`; it is firmer evidence than a screenshot |
| Behaviour after a lost connection | Kill your own collab process by its recorded PID |
