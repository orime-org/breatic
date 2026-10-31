# @breatic/provider

The model provider layer: every model call (media generation, understanding, LLM chat, the decisions endpoint) goes through it, and it answers which upstream serves it, how our params become that upstream's fields, what a run is estimated to cost and what it actually cost. These rules apply when you change anything under `packages/provider/`, `config/provider/` or the two `scripts/provider-*.ts` generators.

### It stands alone

**The package imports no `@breatic/*` package and no other package's source (`provider-no-internal-import` in `.dependency-cruiser.cjs`); key reading, configuration and text cleaning come in through `createProvider`'s options, and each call's deadline comes in on that call.** It is a routing layer meant to be able to leave this repository, so it never reads `process.env`, never logs and never writes the application's database. Check: about to import a helper from `@breatic/shared` or `@breatic/core`? Write or move it inside the package, or take it as an option.

### Its own HTTP module

**Every outgoing request goes through `src/http/request.ts`: adapters call `send` and the readers beside it, and every AI SDK provider is built with its `aiSdkFetch` (`src/llm/vendors.ts`).** That file is the one place in the repository besides `@breatic/shared`'s transport allowed to call the platform `fetch` (the `breatic/no-naked-fetch` exemption in `eslint.config.ts`). A submit is sent with `replaySafe: false`; media polls, result and billing queries are replay-safe; every understand request, Gemini Files API steps included, is delivered once (`exchange`).

### Three entry points

| Entry | Who may import it |
|---|---|
| `@breatic/provider` | domain, server, worker: `createProvider`, LLM calls, costs, errors |
| `@breatic/provider/pricing` | web as well: it runs in the browser, so `src/pricing/` imports only itself, `zod` and `jsonata` (`provider-pricing-browser-safe`) |
| `@breatic/provider/media` | worker only (`provider-media-worker-only`): media runs happen only in the worker, per [AGENTS.md#aigc-generation-runs-in-the-worker](../../AGENTS.md#aigc-generation-runs-in-the-worker) |

### Configuration is checked whole at load

**`config/provider/upstreams.yaml`, `llm.yaml` and `media/*.yaml` are parsed by `src/config/schema.ts` with strict objects: an unknown key, a weight used twice for one model, an upstream kind no adapter speaks to or a pricing rule of the wrong shape fails `createProvider` with every problem named.** The deployment's weight overrides live in `config/provider/routing.yaml`, which is not distributed; the repository ships `routing.yaml.template`. Every shipped LLM route and its key variable is locked by `src/config/__tests__/shipped-config.test.ts`; renaming an upstream renames what calls are charged under.

### Moving to the next upstream

**Weight 0 is the model's official API where it has one (a model reached only through a reseller, such as the catch-all LLM route, has the reseller at 0), and smaller weights are tried first; a call moves on only when the upstream has no key configured, was never reached, answered 408, 429 or 5xx, said it has no such model, or said the balance is too low; an LLM call also moves on 409, and retries on the same upstream first (`llmMaxRetries`).** A 400 or 422, a request that left without an answer, a passed deadline, and anything after the upstream accepted a submit or sent its first content stay on that upstream. Each upstream's "no such model" and "balance too low" answers are matched in its own adapter, never across upstreams.

### Every billed answer reaches the caller once

**Whatever an upstream answered and however a call ended (finished, refused, cut mid-body, deadline, caller stop, switch, retry), each answer an upstream billed is handed to the caller exactly once: on the answer's `costs` or its finish (`costOf`), in `pendingCosts()`, on the error (`costsOf`) or from `abandon`.** This is a critical path; the fast-check properties in `src/llm/__tests__/*-costs-property.integration.test.ts`, `src/media/__tests__/runner-costs.integration.test.ts` and `runner-describe.integration.test.ts` hold it. Check: adding a new way for a call to end, or a new upstream answer shape? Add it to those generators before changing the code.

### One reader per answer shape

**Each upstream answer shape has one reader (`costedOf` for OpenRouter's id and usage, the zod schemas in `src/llm/understand/google.ts` for Gemini, `messageOf` and `errorOf` in `src/llm/vendors.ts` for an error body, `pricingRuleSchema` and `upstreamPricingSchema` for pricing); a field of that shape is read through it, never through a second cast elsewhere.** A second reader drifts from the first, and the field it reads often decides whether a billed answer is recorded or a call moves on.

### The ticket carries the state

**A media run's state lives in the ticket provider hands back; the application stores it and passes it to the next `send`, `poll`, `recover` or `abandon`.** Provider keeps no run state between calls, so any field a later step needs must be in the ticket and survive a JSON round trip.

### Tests

- **Upstreams are faked with the loopback server in `src/media/__tests__/fake-upstream.ts` (`hold`, `cut`, `reset`, `hang`) and the LLM fakes in `src/llm/__tests__/llm-harness.ts`; nothing in the test suites calls a real upstream.**
- **`test/fixtures/*.json` are frozen answers of the code provider replaces, written by `scripts/provider-fixtures.ts`; never edit them by hand.** `scripts/provider-config-migration.ts` writes `config/provider/` from today's catalog the same way.
