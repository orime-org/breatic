# @breatic/ingest

The Worker the browser sends its file bytes to. It writes them into R2, hashes
what actually landed, and reports the outcome to our server.

It holds no database and asks us nothing. Everything it is allowed to do comes
from a ticket our server signed: the storage key, the studio, the part layout
and the size ceiling all travel inside one HMAC, so every check it performs is
against values the browser cannot alter.

## Setting it up

Two files carry configuration, and neither is committed. Each has a committed
template beside it; copy the template, drop the `.template` suffix, and replace
the values with your own.

| Copy this | To this | Put in it |
|---|---|---|
| `wrangler.toml.template` | `wrangler.toml` | Bucket name, and the two addresses this Worker talks to |
| `.dev.vars.template` | `.dev.vars` | The shared secret |

Nothing appears in both files, so nothing overrides anything: what a name means
is decided in exactly one place.

### wrangler.toml

Every setting appears once per environment. The top level is what
`wrangler dev` runs; `[env.production]` is what `pnpm deploy` deploys. The two
environments differ only in what the values are.

| Setting | Local value | Production value |
|---|---|---|
| `bucket_name` | The bucket your local server writes to — the same as `R2_BUCKET` in the repo-root `.env` | The live bucket |
| `SERVER_REPORT_URL` | `http://localhost:<PORT>/api/v1/assets/ingest-report`, where `PORT` is the one in your `.env` | The live API host |
| `ALLOWED_ORIGINS` | `http://localhost:<VITE_DEV_PORT>`, from the same `.env` | The live site host |
| `remote` on the R2 binding | `true` | Absent — a deployed Worker is already next to the bucket |

`ALLOWED_ORIGINS` is what the browser is checked against. The browser sends its
parts to this Worker rather than to the bucket, so this Worker answers the
preflight itself and the bucket needs no CORS rules of its own. A part carries
`x-upload-token`, which makes it a non-simple request, so a browser whose origin
is not listed here never sends the bytes at all.

### .dev.vars

One value: `INGEST_SHARED_SECRET`. It must be the same string as
`INGEST_SHARED_SECRET` in the repo-root `.env` — the server signs upload tickets
with it and this Worker verifies them, so a mismatch rejects every upload with
401. Generate one with `openssl rand -hex 32`.

The deployed Worker gets the same value through
`wrangler secret put INGEST_SHARED_SECRET --env production`, which stores it on
Cloudflare rather than in any file.

### If a setting is missing

Every request answers 500 with the names of what is missing. The check runs
before anything reads a binding, so it holds for the preflight too.

## Running it

| What | Command |
|---|---|
| Locally | `npx wrangler dev` — listens on `http://localhost:8787` |
| Tests | `pnpm test` from the repo root |
| Deploy | `pnpm deploy` (it passes `--env production`) |

Point the repo-root `.env`'s `INGEST_BASE_URL` at whichever one the browser
should talk to, and restart the server so it reads the new value — `.env` is not
watched, so a running server keeps whatever it started with.

`remote = true` on the R2 binding is what makes a local upload land in the real
bucket. Without it `wrangler dev` simulates R2 on disk, and every object it
stores resolves to a 404 at its public URL — which fails anything that reads an
asset back, the video cover job included, since that one downloads the video
from that URL before it can pull a frame out of it.

The Worker itself still runs on this machine, which is the half `wrangler dev
--remote` gives up: that flag moves the Worker to Cloudflare's edge, where
`SERVER_REPORT_URL` on localhost is unreachable and no report ever arrives.
Durable Objects stay local either way — Cloudflare does not offer them as a
remote binding, and an upload session is exactly the kind of state that belongs
next to the code reading it.

## Tests

They run inside workerd, the runtime this Worker deploys to. The things worth
testing here have no Node equivalent to stand in for them: a Durable Object that
keeps state between requests, R2 multipart uploads, and `crypto.DigestStream`.
A mock of any of them would be a mock of what we believe the platform does.

The test configuration declares its own bindings and compatibility date in
`vitest.config.ts`, so the suite runs on a checkout that has no `wrangler.toml`.

`compatibility_date` is pinned to what the workerd bundled with
`@cloudflare/vitest-pool-workers` supports. A later date deploys under runtime
flags the tests never ran against. Raise both together.
