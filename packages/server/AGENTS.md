# @breatic/server

The HTTP service (Hono). These rules apply when you change anything under `packages/server/`.

## Layout

### Server modules

**Server-only business logic lives in `src/modules/<domain>/`, each with its own service, repo and tests; routes and middleware reach services through the `@server/modules` barrel, except `credit-refund/`, which is not in the barrel and whose files are imported directly.** The barrel re-exports services only, so one place shows what the routes depend on.

## Internal API and back office

### Internal API is a second listener

**Routes under `routes/internal/` and the `middleware/internal-*` files mount only on the app built by `createInternalApp()` in `internal-app.ts`, never on the public app.** That app is a second listener, started only when `INTERNAL_API_ENABLED=true` and bound to `INTERNAL_API_HOST:INTERNAL_API_PORT` (default `127.0.0.1:3002`), and every request must carry a signature made with `INTERNAL_API_SECRET` (or `INTERNAL_API_SECRET_PREVIOUS` during rotation); a route mounted on the public app is reachable from the internet. With it enabled the process also runs the credit-refund loop, and startup exits when `config/credit-refund.yaml` cannot be read.

Who can reach the port is decided by where it is published. Before changing the listener, its ports or the deployment, read [self-host/DEPLOYMENT-CONNECTIONS.md](../../self-host/DEPLOYMENT-CONNECTIONS.md#back-office-internal-api).

### The back office writes only through internal endpoints

**The back office never writes the product database; every write it needs is an internal endpoint in this package that performs the write itself, including any Stripe call.** The back office records the request and its audit trail, calls the endpoint and shows the result, so every change passes through the product's own rules and transactions.

## Auth

### Unauthenticated entry points are rate limited

**Register, login, Google login and password recovery are rate limited, and every limit is defined only in `config/rate-limits.yaml`.** Counting uses only the `X-Real-IP` our nginx writes (IPv6 counted per /64), and a request that did not come through our proxy and is not from loopback gets 403. Login, password recovery and recovery-code reset are also counted per address plus email, so people behind one exit address do not use up each other's attempts. All limits for a request are decided in one step, and a rejected request consumes none of them.

**Signup by email is two-step when mail is enabled: a 6-digit code must be entered before the account and session are created, no recovery code is issued, and recovery goes by email. With mail disabled, signup creates the account and session at once and shows a recovery code, and recovery uses only that code.** A user without a personal studio is sent through onboarding.

**Every environment requires login; no switch turns it off.** `repo-lint`'s `no-auth-bypass-residue` scans every tracked file, whatever its extension.

### Protected routes answer 401

**A route behind `requireAuth` (`middleware/auth.ts`) answers 401 to an unauthenticated request; 404 only means no such route.** A 404 from an unauthenticated probe therefore says nothing about whether a protected route exists.

## Errors and requests

### AppError messages come from t()

**Services throw `AppError` subclasses, and every message comes from `t()`, never a literal.** `errorHandler` (`middleware/error-handler.ts`) sends `AppError.message` to the client as is, and the product ships in five languages.

**The error handler decides the response by who caused the error: only `AppError` (ours) and `HTTPException` (Hono could not read the body) map to their own status; everything else is a 500 plus `logger.error`.** An exception's type says something failed to parse, not whose input it was; our own config yaml is parsed lazily inside requests.

**Routes never parse request bodies themselves; they mount `validate(target, schema)` from `middleware/validate.ts`.** `breatic/no-untranslated-error-message` and `breatic/no-raw-body-parse` enforce both rules.

Check: will a user read this sentence? Then it must come from `t()`.

## Streaming and chat

### SSE streams are private and stop on abort

**SSE is used only by agent chat (`routes/chat.ts`, `/message`) and the text mini-tool (`routes/text-tools.ts`); each request gets its own private stream, and event `data` carries no ownership ids.** Ownership is held by the `conversations` row (`user_id`, `project_id`); per-operation audit goes to the application logger, not onto the wire.

**Every SSE entry subscribes to `s.onAbort` and passes that signal down to the layer doing the work.** When the client leaves, `StreamingApi.write` swallows the write error, so a loop that only watches its own writes never notices and keeps calling the model, running tools and charging the user.

Check: will this stream's producer stop by itself when nobody is listening? If not, it must receive the signal.

### SSE finalization is a plain async function

**Work that must happen when a turn ends (persisting, billing) is a plain async function that does all its side effects and returns the events to emit; the stream awaits it and then yields them.** A client disconnect calls `.return()` on the generator: code after the loop is skipped, code after the first `yield` in `finally` does not run, and `yield*` to an inner generator in `finally` runs none of it. `packages/domain/src/agent/turn-finalizer.ts` has this shape.

Check: does this finalization still run when nobody reads the stream any more? Test disconnects with `gen.next()` then `gen.return()`; a test that reads the stream to the end cannot find this.

### A complete tool call is not an executed one

**A tool call the AI SDK has fully assembled has not necessarily run.** Calls are queued and executed only at the step's `model-call-end`, which comes from the provider's `finish`; a turn stopped before `finish` arrives leaves a complete call with full arguments that never ran, and it carries no `argumentsIncomplete`. Once a tool does start, it always reports an end.

Check: am I asserting a call certainly ran, or certainly did not? First establish where the turn stopped. To build that window in a test, hold back the `finish` part and stop the turn once the stream has been read dry, as `__tests__/agent/tool-part-terminal-state.test.ts` does in `does not say a fully-sent call the turn never ran was still running`.

### Conversation ownership

**Conversation ids come from the client, so every endpoint that writes into a conversation first checks that it belongs to this user, belongs to this project and is not soft-deleted, and answers 404 for each failure.** A user may have several tabs on different conversations, so the server cannot hold a "current" one.

**A conversation is created automatically in one place only, the open-chat endpoint; every other endpoint that takes a conversation id writes to it and never creates one.** `POST /chat/conversations` creates one only when the user asks for a new conversation. A second creation point turns a stale id into a silent new conversation while the user thinks they are still in the old one.

Check: am I writing to a conversation id the client gave me? Were all three checked? Details: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#chat-conversation-ownership).

### The system prompt names no tool

**The system prompt (`src/agent/context.ts`) holds only rules that apply to every tool (call tools rather than writing the call out, read errors, say what you could not get); it says nothing about any particular tool, even without naming it.** A tool's guidance lives in its own definition ([domain rule](../domain/AGENTS.md#tool-guidance-lives-in-the-tool-definition)); `__tests__/agent/system-prompt.test.ts` catches only tool names, so an unnamed description is caught by this rule alone.

## Payments

### Stripe behaviour is verified against Stripe

**Unit tests with a stubbed Stripe client (`src/infra/stripe.ts`) verify only the request we send; every path Stripe may reject or answer unexpectedly is run once against Stripe itself, and the response observed is recorded.** The stub answers with what we expect, so an illegal parameter combination or an unexpected status passes every unit test and fails every real call.

Check: is this assertion about what we send, or a prediction of how Stripe answers? A prediction needs a real run.

### Payment webhooks are idempotent

**Payment webhook handling is idempotent through a CAS on `payments.status` (`modules/payment/payment.service.ts`).** Stripe redelivers events, and two deliveries of one event must not both fulfil it.
