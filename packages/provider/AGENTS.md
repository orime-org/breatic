# @breatic/provider

The model provider layer: every model call (media generation, understanding, LLM chat, the decisions endpoint) is to go through it once the application moves onto it (inner#1743), and it answers which upstream serves it, how our params become that upstream's fields, what a run is estimated to cost and what it actually cost. Until that move the application still calls upstreams itself. These rules apply when you change anything under `packages/provider/`, `config/provider/` or the `scripts/provider-*` generators.

### It stands alone

**The package imports no `@breatic/*` package and no other package's source (`provider-no-internal-import` in `.dependency-cruiser.cjs`); key reading, configuration and text cleaning come in through `createProvider`'s options, and each call's deadline comes in on that call.** It is a routing layer meant to be able to leave this repository, so it never reads `process.env`, never logs and never writes the application's database. Check: about to import a helper from `@breatic/shared` or `@breatic/core`? Write or move it inside the package, or take it as an option.

### Its own HTTP module

**Every outgoing request goes through `src/http/request.ts`: adapters call `send` and the readers beside it, and every AI SDK provider is built with its `aiSdkFetch` (`src/llm/vendors.ts`).** That file is the one non-test file the `breatic/no-naked-fetch` exemption in `eslint.config.ts` names besides `@breatic/shared`'s transport directory (`packages/shared/src/http/`). A submit is sent with `replaySafe: false`; media polls, result and billing queries are replay-safe; every understand request, Gemini Files API steps included, is delivered once (`exchange`).

### Three entry points

| Entry | Who may import it |
|---|---|
| `@breatic/provider` | domain, server, worker: `createProvider`, LLM calls, costs, errors |
| `@breatic/provider/pricing` | web as well: it runs in the browser, so `src/pricing/` imports only itself, `zod` and `jsonata` (`provider-pricing-browser-safe`) |
| `@breatic/provider/media` | worker only (`provider-media-worker-only`): media runs happen only in the worker, per [AGENTS.md#aigc-generation-runs-in-the-worker](../../AGENTS.md#aigc-generation-runs-in-the-worker) |

### Configuration is checked whole at load

**`config/provider/upstreams.yaml`, `llm.yaml` and `media/*.yaml` are parsed by `src/config/schema.ts` with strict objects: an unknown key, a weight used twice for one model, an upstream kind no adapter speaks to or a pricing rule of the wrong shape fails `createProvider` with every problem named.** The deployment's weight overrides live in `config/provider/routing.yaml`, which is not distributed; the repository ships `routing.yaml.template`. Every shipped LLM route and its key variable is locked by `src/config/__tests__/shipped-config.test.ts`; renaming an upstream renames what calls are charged under.

### Vendor limits live on the model

**A model vendor's input limits are written once, as the model's `rejects` in `config/provider/media/*.yaml` (our param names, the prompt as `prompt`, the vendor's words and the vendor page as `source`); a binding's `rejects` hold only what that reseller enforces beyond the vendor.** Each reseller forwards to the vendor, so a limit copied per binding drifts and a reseller that misses it sends runs the vendor refuses. A limit the vendor has announced for a date carries `from` and holds from then on, in the estimate and the browser alike. Whether a param is filled at all is never a reject, at the model or a binding, and stays the application's check at submit: such a reject would blank the estimate before the user has typed. Check: is the limit the vendor's, or only this reseller's? The vendor's goes on the model, whatever the reseller's schema says.

### Moving to the next upstream

**Weight 0 is reserved for the model's official API, and smaller weights are tried first; an LLM route only a reseller serves (the catch-all route) has that reseller at 0, while media models have no official adapter yet, so their resellers start at 1 and weight 0 stays empty; a call moves on only when the upstream has no key configured, was never reached, answered 408, 429 or 5xx, said it has no such model, or said the balance is too low; an LLM call also moves on 409, and retries on the same upstream first (`llmMaxRetries`).** Any other 400 or 422, a request that left without an answer, a passed deadline, and anything after the upstream accepted a submit or sent its first content stay on that upstream. Each upstream's "no such model" and "balance too low" answers are matched in its own adapter, never across upstreams.

### Every billed answer reaches the caller once

**Whatever an upstream answered and however a call ended (finished, refused, cut mid-body, deadline, caller stop, switch, retry), each answer an upstream billed is handed to the caller exactly once: on the answer's `costs` or its finish (`costOf`), in `pendingCosts()`, on the error (`costsOf`) or from `abandon`.** This is a critical path; the fast-check properties in `src/llm/__tests__/*-costs-property.integration.test.ts`, `src/media/__tests__/runner-costs.integration.test.ts` and `runner-describe.integration.test.ts` hold it. Check: adding a new way for a call to end, or a new upstream answer shape? Add it to those generators before changing the code.

### One reader per answer shape

**Each upstream answer shape has one reader (`costedOf` for OpenRouter's id and usage, the zod schemas in `src/llm/understand/google.ts` for Gemini, `messageOf` and `errorOf` in `src/llm/vendors.ts` for an error body, `pricingRuleSchema` and `upstreamPricingSchema` for pricing); a field of that shape is read through it, never through a second cast elsewhere.** A second reader drifts from the first, and the field it reads often decides whether a billed answer is recorded or a call moves on.

### The ticket carries the state

**A media run's state lives in the ticket provider hands back; the application stores it and passes it to the next `send`, `poll`, `recover` or `abandon`.** Provider keeps no run state between calls, so any field a later step needs must be in the ticket and survive a JSON round trip.

### Tests

- **Upstreams are faked with the loopback server in `src/media/__tests__/fake-upstream.ts` (`hold`, `cut`, `reset`, `hang`) and the LLM fakes in `src/llm/__tests__/llm-harness.ts`; nothing in the test suites calls a real upstream.**
- **`pnpm test:integration` runs both suites in one run under `vitest.coverage.config.ts`, which fails, naming each file and its uncovered lines, below 100% coverage of the files its `include` lists: the estimate and the formula evaluator, routing, the media runner and its adapters, and every reader of an actual cost.** A branch no input can reach (a fallback only the types need) carries `/* v8 ignore next -- @preserve */` under a comment saying why; anything an input can reach gets a test.
- **`test/fixtures/upstream-*.json` are frozen answers of the code provider replaces, written by `scripts/provider-fixtures.ts`; `three-d-prices.json` and the `upstream-schemas/` and `upstream-prices/` snapshots are what the upstreams state, written by `pnpm provider:prices`; the `bodies/` samples are what the runner sends each reseller, written by `pnpm provider:reseller-bodies`; never edit any of them by hand.** `scripts/provider-config-migration.ts` regenerates only part of `config/provider/` and merges it into the files already there: each model's WaveSpeed binding (from the `config/models/` catalog), the WaveSpeed upstream, the LLM upstreams and routes (from `packages/domain/src/agent/llm.ts`), the direct LLM `prices` and `routing.yaml.template`; change the script, not the lines it writes. `pnpm provider:prices` writes fal's `base_price`, the 3D prices and the OpenRouter fields of `llm.yaml`. Reseller bindings and each model's `rejects` are written by hand.
