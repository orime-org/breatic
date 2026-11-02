# @breatic/shared

The protocol layer used by both web and the backend: zod schemas, types, constants, cross-service event formats, Space document names (`src/yjs-doc-names.ts`), scene value schemas, root validation and empty-document initialization (`src/scene.ts`, `src/scene-version.ts`), the HTTP transport (`src/http/`), backoff (`src/backoff.ts`), and text rules both sides must apply identically (`src/agent/extract-prompt.ts`: web counts characters with it, worker cleans prompts with it). These rules apply when you change anything under `packages/shared/`.

## Package boundary

### Logic both sides compute lives here once

**Anything web and the backend must compute the same way is implemented once, here.** Two implementations drift apart, and then the browser and the server disagree about the same input.

### Browser-safe dependencies only

**Everything in this package must run in a browser: no `node:*`, `fs` or `async_hooks` imports, and the package stays `"sideEffects": false`.** web imports this package, so a Node-only import is pulled into the web bundle through the barrel; nothing checks this except the chunk guard's total byte budget.

### shared imports no workspace package

**shared imports no other workspace package, `@breatic/core` included.** It is the bottom of the dependency graph; dependency-cruiser's `library-no-app-import` blocks the app packages but not core.

## Entry points

### Main entry and subpaths

**The main entry `src/index.ts` (bundled by `tsup`) is the default; the subpath entries are `@breatic/shared/canvas/text-body`, `@breatic/shared/mini-tools`, `@breatic/shared/pricing` and `@breatic/shared/space-content`.** The `exports` map in `package.json` and the `build` script list the same five. Timeline Yjs document operations and Space media-reference extraction use `space-content`.

**A new export exists for other packages only once `src/index.ts` (or a subpath entry) exports it; adding it to a sub-barrel such as `types/index.ts` is not enough.** Consumers resolve `@breatic/shared` to `src/index.ts`, so a symbol missing there can pass locally and fail the CI build.

### Barrel or subpath

Check: will web call this module's exports? If yes, put it in the barrel, run `pnpm build && pnpm --filter @breatic/web verify:chunks`, and give the module its own subpath entry if the guard fails. Modules web never calls go in the barrel.

**Decide with the guard, never by reading the code.** The main entry builds to one file, so every export web reaches from the barrel ships in the entry chunk that every reader downloads, even if only a lazy page calls it, and what an export drags along depends on everything it calls. `packages/web/verify-chunks.mjs` names known heavy dependencies in `HEAVY` and caps the total with `ENTRY_BUDGET`; the list lags, so a new heavy dependency shows up only as the total going over.

## HTTP transport

### The transport does eight things

**`httpRequest` does these eight things and no ninth; the list is its definition, its acceptance criteria and its stopping point:**

1. Send the request with the caller's URL and options unchanged.
2. Decide whether to resend: protocol semantics (429, 408 and 5xx may be resent, other 4xx not), the caller's `replaySafe`, and whether the body can physically be sent again, which the transport decides itself.
3. Decide how long to wait: the server's `Retry-After` when given, otherwise exponential backoff.
4. Send at most three times (`MAX_RETRIES` and `BASE_DELAY_MS` are fixed in `http/constants.ts`, deliberately not configurable).
5. Return the native `Response` for any response received; throw when none was received, as `HttpRetryError` with the attempt count once it has retried.
6. While the call runs, hang at most one listener on the caller's signal besides what the delivery itself creates; after the call, hold nothing.
7. Stop when the caller's `signal` aborts: abort the delivery in flight, start no retry, cut the backoff short, and stop the body of a `Response` already returned.
8. With `idleTimeoutMs` and a byte body (`Blob`, `ArrayBuffer`, a view), send through `XMLHttpRequest` and abort when no bytes move for that long; where there is no `XMLHttpRequest` the option throws, and Node callers time the socket with core's `idleSocketDispatcher`.

Check: is what I am adding one of these eight? If not, it is a ninth, and it is added only when a maintainer explicitly asks. A review finding is a defect only when it traces to one of the eight not being met.

### The transport ends at the response headers

**Reading the body belongs to the caller: the read group (`http/read-within.ts`, `http/reason.ts`) and the deadline group (`http/deadline.ts`) live in `src/http/` but are not part of the eight.** Only the caller knows how big a body may be and how long reading it may take.

### Callers declare four things

**The caller declares `replaySafe`, `timeoutMs` (default `DEFAULT_TIMEOUT_MS`, 300 s), `signal` and `idleTimeoutMs`; the transport never computes them.** It sees one URL and some bytes, while the caller knows which model is slow and how big the file is.

Check: can this layer infer the value from a URL and some bytes? If not, it is a parameter, not a constant.

**Never set `replaySafe: true` to make a call "more reliable".** It states that sending again has no second side effect; on a billing endpoint such as a vendor's `POST /predictions` it makes us pay twice.

### Exports are a promise

Check: does this export make the layer do one more thing, or state a rule the layer already enforces, and does it have a real consumer outside the package? Only the second kind is exported; `src/index.ts` is the list of what is.

### Cancellation reaches the returned body

**Before changing cancellation in `http/request.ts`, read the header comment of `http/__tests__/cancellation.integration.test.ts`: stopping cleanly takes four guards, each with its own test.**

**A returned `Response` stays bound to the caller's signal, so aborting stops its body read; never detach a returned response from the signal.** Callers depend on it: the agent's search tools read bodies with `readWithin(res, budgetMs, signal)` and rely on a stop ending the read at once.

### Plain HTTP connections end on their own

**Write no guard, timeout knob or fallback for a plain HTTP request that never ends.** Platforms, proxies and the OS cut every plain HTTP connection (Node's fetch rejects a silent server after about 301 s, recorded in `http/constants.ts`), so that case does not occur; SSE and WebSocket stay open by design and are a separate matter.

Check: is the case I am guarding "the connection never closes"? Then do not write it.

## Membership

### Two membership tier sets

**`MEMBERSHIP_TIERS` in `types/membership.ts` lists the five tiers an account can hold and matches the database CHECK constraint; `CONFIGURED_MEMBERSHIP_TIERS` lists the four whose limits are in `config/membership.yaml`.** `enterprise` must be in the first, or core's `asKnownTier` rejects a value the database allows and every limit lookup for that account fails; it never goes in the yaml, because its limits are negotiated per contract and invented numbers would grant quotas nobody agreed to. `getMembershipLimits` takes `ConfiguredMembershipTier`, so the compiler makes every path from tier to quota handle `enterprise`.

Check: does this set answer "can an account hold this tier" (five) or "where are this tier's quotas" (four)?
