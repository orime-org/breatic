# @breatic/ingest

The ingest Worker on Cloudflare. The browser sends file bytes straight to it; it writes them into R2, hashes what landed, and puts what it measured in the response to the finish request. Read [README.md](./README.md) before configuring, running locally or deploying this Worker.

## Two runtimes

**`src/` runs on workerd: no `node:*`, no database, no Redis, and configuration comes only from the fetch handler's `env` (wrangler bindings and vars), never `process.env`.** This is the only package in the repo on workerd. `container/` is the media container (alpine and Node, see `Dockerfile`) that runs ffmpeg and vips, so `node:*` is valid only there.

**Import only `@breatic/shared`.** Core and domain use Node APIs that workerd cannot load, and no lint rule catches that import. The upload ticket and per-part session token are signed and verified in `shared/src/upload/` because both this Worker and the server verify them; moved into this package, the server could not reach them and the two sides would drift apart and reject each other.

**The container's own process loads only Node built-ins and this repo's code, and every module it loads must be listed in `container/tsconfig.json`.** ffmpeg and vips run as separate processes so their GPL-licensed libraries stay out of our process (`THIRD-PARTY.md`); `breatic/media-container-own-code-only` reports a missing entry.

## Endpoints

`src/index.ts` routes seven endpoints and CORS:

| Endpoint | Who calls it |
|---|---|
| `POST /uploads`, `POST /fetch`, `PUT` part, `POST` finish | The upload path: the browser opens an upload and sends parts, our services pull a source URL (`/fetch`) and finish |
| `POST /media` | Our worker: read width, height and duration of a stored object whose finish skipped that read, or an audio object's peaks |
| `POST /jobs`, `GET /jobs/{class}/{id}` | Our worker: submit and poll container mini-tool jobs (`src/jobs/`) |

**`POST /media` is not read-only: with `wantPreview: true` the Worker writes the preview the container cut to `<key>.preview.webp`, and with `wantPeaks: true` the peaks the container read to `<key>.peaks.json`.** The finish decides the preview itself from the stored type; a peaks read whose file already stands answers `existing` without starting a container, because its only callers read nothing else.

**A finish with `deferMediaRead: true` skips the media read, except for still images with EXIF orientation 2 to 8, which still go through the container to be turned upright.**

**Every refusal on the four upload-path endpoints has a definite status: ticket or token fails 401, bad part length or unfinished part 400, manifest missing parts 409, stored or source type refused 415, `/fetch` source over the ticket cap 413, R2 write or hash failure 502.** Finish, `/fetch`, `/media` and both `/jobs` endpoints require the shared secret (401 otherwise); the browser never holds it, so only our services can call them. `/fetch` answers 400 for a non-https source; `/media` answers 400 for a bad body and 404 when the key has no object.

## The only outbound request

**The Worker never calls our endpoints and holds none of their addresses; its only outbound request is `POST /fetch` pulling the named source, sent with the User-Agent from `src/source-request.ts`.** Some sites refuse requests without it, and a Worker's `fetch` sends none of its own.

## State

**The upload path keeps no state between requests: the R2 `uploadId` and each part's etag travel with the caller and come back on every request.** This package also does not judge whether an upload is dead (the server computes task deadlines when a node's task list is read) or whether a key is already being finished (the server takes that grant from the ledger before calling).

**It binds three Durable Object classes, all containers: `MediaContainer` (one per storage key, idles after answering) and `MiniToolContainerStd1` / `MiniToolContainerStd4` (`src/jobs/mini-tool-container.ts`, same image, one class per instance size, one instance per job id, destroyed at the job deadline).** `config/mini-tools.yaml` names the class each operation runs in.

**A container cannot reach the internet; downloading the source, writing results back and reporting all go through the Worker's outbound handler, which only allows the keys the job names (`src/jobs/mini-tool-container.ts`).**

## Bytes and R2

`src/stored-object.ts` assembles the object and hashes it. `src/part-layout.ts` checks a part against the layout the ticket signed: once before writing to R2, the only moment bytes can still be stopped, and again item by item over the manifest at finish before counting parts.

## Failures

**Every failure goes through `noteFailure` in `src/error-monitoring.ts`; never `console.error` a new failure directly.** It always logs and reports by default; pass `userInput: true` only when the reader's own input caused it (an unreachable link they gave, a part whose sender stopped mid-body, stored bytes of a type we refuse). Check: do we need to fix this failure? Caused by the reader's input → `userInput: true`; anything else → report.

**Keep "reading the source failed" apart from "writing R2 failed": the first is the sender's side, the second is ours.** `writeStreamAsParts` throws `SourceReadError` for the first.

**A new required var or binding goes into `REQUIRED_SETTINGS` in `src/index.ts`, so a missing one answers 500 with its name.**

## Configuration

**Only people changing this Worker, or running a full upload on their own machine, need to configure it.** Typecheck, unit tests and integration tests never touch it, so do not set it up to run tests.

**Wrangler does not interpolate `${VAR}`; values in `wrangler.toml.template` are notes for humans.** A `${X}` in `[vars]` arrives as the literal string.

## Deploy

**Deploy with `pnpm --filter @breatic/ingest deploy:worker` (it passes `--env production`); the script exists only in this package, so `pnpm deploy:worker` at the repo root fails.** The name has a suffix because `pnpm deploy` is a pnpm subcommand that would shadow a script called `deploy`.

### Redeploy after an ingest PR merges

**After a PR that changed `packages/ingest` merges, redeploy the deployed Worker from a clean `origin/main`, never from a task branch.** Local checkouts whose `INGEST_BASE_URL` points at the deployed Worker sign tickets against `main`, and a stale Worker fails their uploads. Check: `git diff --name-only <merge>^1 <merge> | grep ^packages/ingest/` prints anything → redeploy.

1. Check out `origin/main` in a separate worktree, run `pnpm install --frozen-lockfile`, and copy your `wrangler.toml` in.
2. Compare with what is live: `npx wrangler deployments list --env production`, then `npx wrangler versions view <id> --env production --json`; `npx wrangler deploy --env production --dry-run` must list the same bindings and vars (`containers` and Durable Object bindings do not inherit into `[env.production]`).
3. `pnpm --filter @breatic/ingest deploy:worker --var SENTRY_RELEASE:<merge commit>`, then confirm each container application reports `SUCCESS Modified application`.

## Tests

**Most tests run in real workerd (`@cloudflare/vitest-pool-workers`), because R2 multipart and `crypto.DigestStream` have no Node stand-in; a mock would only encode our guess about the platform.**

**Tests that touch neither run on Node and end in `.node.test.ts`; `vitest.config.ts` splits the two projects by that suffix.** Check: does this test assert platform behaviour or our own logic? Platform → workerd; our logic with no R2 and no `DigestStream` on the path → Node.

**A test that asserts on elapsed time runs on Node.** Isolate start-up in the pool is scheduled by the pool, not the test, and varies by orders of magnitude between runs.

**`src/media-read.ts` (edge side) may only `import type` from `src/media-container.ts`; the dependency runs container → edge.** The container class pulls in `cloudflare:workers` at load time, and one value import drags it into Node tests.

**Tests declare their own bindings and compatibility date in `vitest.config.ts` and never read `wrangler.toml`.** That file is not committed, so a test reading it only runs on machines that happen to have one.
