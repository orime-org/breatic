# @breatic/domain

The business core shared by server and worker. These rules apply when you change anything under `packages/domain/`.

## Auth and tasks

### Studio-level auth lives here

**Studio-level authorization (`auth/studioAuth.service.ts`, `auth/studioMembers.repo.ts`) lives in domain; project-level authorization lives in core `auth/`.** Collab checks project roles and cannot import domain, so project-level code placed here is out of its reach.

### Upstream step repos are worker-only

**`task/upstreamStep.repo.ts` (`task_upstream_steps`) and `task/upstreamClone.repo.ts` (`studio_upstream_clones`) are read and written only by worker.** They are worker's record of each upstream call it made, and a retried task resumes from them.

## Credits

### Estimate credits through the model catalog

**Estimate credits only with `estimateModelCredits` / `estimateTaskCredits` in `model-catalog/model-catalog.ts`.** They apply each model's pricing contract through shared `estimateCredits`, and the enqueue pre-check depends on every estimate coming out the same way.

### Charging is atomic and idempotent

**A charge and its ledger rows are written in one `db.transaction()`: a finished task is billed through `markCompletedAndBill`, and a generation is charged through `chargeOnceForGeneration(refKey, ...)`, which charges each `refKey` at most once.** A charge split across transactions, or repeated on a retry, leaves the balance and the ledger disagreeing.

**Every consumption is multiplied by `CREDIT_MULTIPLIER` (default 1).** It is a deployment setting that the model catalog also applies, so a cost computed without it bills a different number than the one shown.

### Losing admin releases credit designations

**The moment someone stops being a studio's admin, every credit lot they designated to that studio is released with `releaseDesignations` (`credit/creditLot.service.ts`), in the same transaction as the role change.** A designation is what lets a studio spend, so lots left designated would keep funding a studio its former admin no longer governs.

## Agent

### Tools and generation templates

**The agent works with two things: tools (one external action each, in `agent/tools/`) and generation templates (a fixed mode, model, parameters and prompt, registered in `packages/shared/src/canvas/generation-templates.ts`).** The agent helps the user work in their Spaces: it calls tools and proposes nodes, optionally starting from a template, and a proposal lands on the canvas only when the user clicks Use.

Check: is this one external action (a tool) or a fixed way of generating (a template)?

Before changing templates or how the agent proposes them, read the generation templates section of [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#%E7%94%9F%E6%88%90%E6%A8%A1%E6%9D%BF).

### The agent runs in its caller's loop

**The agent runs inside the loop of whoever calls it; it starts no other process, thread or agent.** A turn then has one context, one budget and one stop signal.

### Tool guidance lives in the tool definition

**Everything about a tool (what it does, when to use it, how to read its answer) is written in its `description` and its fields' `.describe()`; a template's note to the model is its `agentNote` in the template definition.** Guidance written anywhere else is a second copy that drifts, and it stays behind when the tool is removed. The system prompt side of this rule is [in server](../server/AGENTS.md#the-system-prompt-names-no-tool); `agent/tools/__tests__/tools-say-their-own-use.test.ts` guards this side. A tool or template is handled specially only when that has been explicitly asked for.

Check: is the sentence I am writing about one tool or template? Then it belongs in that tool's or template's own definition.

### One place assembles the agent

**Model, instructions and tools are assembled only by `buildAgentConfig` in `agent/agent-config.ts`.** A second assembly point lets two agents drift apart.

### Tool errors state the problem

**An error returned to the agent states what is wrong, which rule it breaks and the facts needed to reason about it; it names a fix only when the fix is unique and certain from this error alone** (drop a duplicate, copy a fixed value, remove a field that does not exist). A computed fix is a second judgement that must agree with every other check, and those combinations cannot be enumerated.

Check: is this sentence stating the error and the rule, or plotting a route for the reader? If a route, is it the only one, and does following it certainly clear this error?

### Tool failures throw

**A tool's `execute` throws on failure; it does not catch the error and return it as an ordinary result.** The AI SDK turns a thrown error into a `tool-error` the model can act on, while a returned string reads as success; retry behaviour is steered by the system prompt and the model-call layer.
