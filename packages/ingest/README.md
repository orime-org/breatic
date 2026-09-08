# @breatic/ingest

The Worker the browser sends its file bytes to. It writes them into R2, hashes
what actually landed, and reports the outcome to our server.

It holds no database and asks us nothing. Everything it is allowed to do comes
from a ticket our server signed: the storage key, the studio, the part layout
and the size ceiling all travel inside one HMAC, so every check it performs is
against values the browser cannot alter.

## Setting it up

Two files carry this Worker's own configuration, and neither is committed. Each
has a committed template beside it; copy the template, drop the `.template`
suffix, and replace the values with your own.

| Copy this | To this | Put in it |
|---|---|---|
| `wrangler.toml.template` | `wrangler.toml` | Bucket name, ports, and the two addresses this Worker talks to |
| `.dev.vars.template` | `.dev.vars` | The shared secret |

Nothing appears in both files, so nothing overrides anything: what a name means
is decided in exactly one place.

### The server side of the same pipeline

The Worker writes the bytes; the server mints the keys and resolves them into
the URLs that land on nodes. Both halves have to name the same bucket, so the
repo-root `.env` needs these as well — this Worker running perfectly is not
enough on its own.

| In the repo-root `.env` | What it is |
|---|---|
| `STORAGE_PROVIDER=r2` | **The one that decides everything else.** Left at its `local` default, the bytes still reach R2 and the server still resolves them against the local uploads directory, so every node gets a URL that fetches nothing — and no step reports an error |
| `R2_BUCKET` | The same bucket as `bucket_name` in `wrangler.toml` |
| `R2_ACCESS_KEY`, `R2_SECRET_KEY` | An R2 API token's pair. The server reads and writes the bucket over the S3 API with them |
| `R2_S3_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` — the signed API endpoint, not a public one |
| `UPLOAD_BASE_URL` | Where a stored object is publicly readable: the bucket's r2.dev address or a custom domain. This is the URL written onto nodes, and the one ffmpeg downloads a video from to cut its cover |
| `INGEST_BASE_URL` | Where the browser sends its parts: `http://localhost:<[dev] port>` locally, the Worker's public address on a deployment |
| `INGEST_SHARED_SECRET` | The same string as in `.dev.vars` |

### wrangler.toml

Every setting appears once per environment. The top level is what
`wrangler dev` runs; `[env.production]` is what `pnpm deploy:worker` deploys. The two
environments differ only in what the values are.

| Setting | Local value | Production value |
|---|---|---|
| `[dev] port` | The port this Worker listens on. Every worktree on one machine runs its own, so each needs its own — and it has to match the port in the repo-root `.env`'s `INGEST_BASE_URL` | Absent |
| `bucket_name` | The bucket your local server writes to — the same as `R2_BUCKET` in the repo-root `.env` | The live bucket |
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
| Locally | `pnpm dev` from the repo root, or `npx wrangler dev` here — listens on the `[dev] port` |
| Tests | `pnpm test` from the repo root |
| Deploy | `pnpm deploy:worker` (it passes `--env production`) |

Point the repo-root `.env`'s `INGEST_BASE_URL` at whichever one the browser
should talk to, and restart the server so it reads the new value — `.env` is not
watched, so a running server keeps whatever it started with.

`pnpm dev` with no `wrangler.toml` prints what to copy and starts nothing, so a
checkout that has not configured this Worker still gets its frontend and its
API. Uploads are what stops working until it is configured.

`remote = true` on the R2 binding is what makes a local upload land in the real
bucket. Without it `wrangler dev` simulates R2 on disk, and every object it
stores resolves to a 404 at its public URL — which fails anything that reads an
asset back, the video cover job included, since that one downloads the video
from that URL before it can pull a frame out of it.

The Worker itself still runs on this machine, because that is the address it
has to answer on: the browser sends its parts there, and our own server
finishes the upload there. It reaches nobody in return — what it measured over
the stored object is the answer to the finish, not a call it places — so it
holds no address of ours at all.

This Worker binds no Durable Object and keeps nothing between requests: an
upload's id and its part receipts travel with the browser and come back to
finish it.

## Tests

They run inside workerd, the runtime this Worker deploys to. The things worth
testing here have no Node equivalent to stand in for them: R2 multipart uploads
and `crypto.DigestStream`. A mock of either would be a mock of what we believe
the platform does.

The test configuration declares its own bindings and compatibility date in
`vitest.config.ts`, so the suite runs on a checkout that has no `wrangler.toml`.

`compatibility_date` is pinned to what the workerd bundled with
`@cloudflare/vitest-pool-workers` supports. A later date deploys under runtime
flags the tests never ran against. Raise both together.
