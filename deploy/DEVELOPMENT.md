# Development setup

**English** | [简体中文](DEVELOPMENT-CN.md)

This guide is for changing source code, debugging and contributing. To install and use the product, follow [Personal and LAN deployment](LOCAL.md); for a private server with a domain, use [Server deployment](SERVER.md). Run commands from the repository root unless specified otherwise. Keep a second terminal available for checks while services run.

**This is the source-development workflow:** Node.js runs the application; Docker runs PostgreSQL, Redis and the upload service's media container; Wrangler can run Ingest locally. The web entry point is `http://localhost:8000`. The local-Ingest path needs neither a domain nor a deployed Cloudflare Worker.

**This is not offline development.** The current storage implementation needs real Cloudflare R2. AI features need provider accounts, keys and available quota. An accessible homepage does not prove that storage or generation works.

## 1. Tools and accounts

| Requirement | Purpose |
| --- | --- |
| Git | Clone the repository; extracting a full source ZIP also works |
| Node.js | Use 22.x, matching the Docker build's major version |
| pnpm | **9.15.0**, as specified by the root `packageManager`; do not use an arbitrary global version |
| Docker | Running Engine/Desktop with Compose v2 |
| FFmpeg | Both `ffmpeg` and `ffprobe` must be available on the host for background video tools; the copy inside the media container does not replace them |
| Cloudflare | R2 enabled, with a dedicated development bucket and read/write credentials |
| AI providers | A text provider such as OpenRouter, plus credentials for media models you need |

Use a terminal on macOS/Linux. On Windows, use a WSL2 Linux terminal with Docker Desktop integration enabled. Keep Node, pnpm, FFmpeg and source in the same WSL environment. These are not PowerShell commands.

Install the tools, then check:

```bash
node --version
npm install --global pnpm@9.15.0
pnpm --version
docker version
docker compose version
ffmpeg -version
ffprobe -version
```

Expect Node `v22...`, pnpm `9.15.0`, and both Docker Client and Server information. If global installation fails on permissions, correct your Node installation permissions or use a user-level Node version manager first.

## 2. Get the source and environment file

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
cp .env.dev .env
pnpm install --frozen-lockfile
```

For a ZIP, extract it and enter the directory containing **`package.json` and `pnpm-workspace.yaml`**, then start with `cp .env.dev .env`. If repository access requires authentication, download with an authorized GitHub account.

Edit `.env`, leaving `.env.dev` as the template. Do not use `.env.docker`: its addresses are for containers, not host-side Node processes. Do not overwrite an existing `.env`.

Keep one definition per key. Replace sample keys with real credentials and clear unused provider keys; fake values may be treated as configured services.

```dotenv
ENV=dev
COOKIE_DOMAIN=
PORT=3000
COLLAB_PORT=1234
SERVER_HEALTH_PORT=3001
WORKER_HEALTH_PORT=9101
COLLAB_HEALTH_PORT=1235
VITE_DEV_PORT=8000
ALLOWED_ORIGINS=http://localhost:8000
DATABASE_URL=postgres://breatic:breatic@localhost:5432/breatic
YJS_DATABASE_URL=postgres://breatic:breatic@localhost:5432/breatic_yjs
REDIS_URL=redis://localhost:6379/0
REDIS_QUEUE_URL=redis://localhost:6379/1
REDIS_STREAM_URL=redis://localhost:6379/2
REDIS_COLLAB_URL=redis://localhost:6379/3
REDIS_KEY_PREFIX=local-breatic
PAYMENT_ENABLED=false
EMAIL_BACKEND=console
```

`PAYMENT_ENABLED=false` disables application payments and the corresponding credit checks; **external model charges still apply**. `EMAIL_BACKEND=console` prints email content to local logs without delivering it. Email/password registration works without Google OAuth. Save your recovery code during registration.

This guide assumes one local instance. Required free ports are `5432`, `6379`, `3000`, `3001`, `1234`, `1235`, `9101`, `8000` and, for local Ingest, `8787`. Do not accidentally connect to another instance's data. See the `.env.dev` header for multi-instance isolation.

## 3. Configure R2 storage

1. Create a dedicated development bucket, for example `breatic-local-yourname`; do not use an existing production bucket.
2. Create **Object Read & Write** R2 S3 credentials scoped to that bucket. Save the Access Key ID, Secret Access Key and account S3 endpoint. These are separate from Wrangler login credentials.
3. Enable the bucket's **Public Development URL**, such as `https://pub-....r2.dev`. Files are publicly readable through their URLs; do not upload confidential material.
4. Save this bucket CORS rule:

```json
[
  {
    "AllowedOrigins": ["http://localhost:8000"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

The rule enables browser reads and image cropping. Uploads go to Ingest, which uses a separate `ALLOWED_ORIGINS` setting in section 4. Configure both.

In the root `.env`:

```dotenv
STORAGE_PROVIDER=r2
R2_BUCKET=breatic-local-yourname
R2_ACCESS_KEY=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_KEY=YOUR_R2_SECRET_ACCESS_KEY
R2_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
UPLOAD_BASE_URL=https://pub-YOUR_PUBLIC_BUCKET_ID.r2.dev
INGEST_BASE_URL=http://localhost:8787
INGEST_SHARED_SECRET=YOUR_GENERATED_SECRET
```

Replace all `YOUR_...` values. Use the S3 endpoint for `R2_S3_ENDPOINT` and the public read URL for `UPLOAD_BASE_URL`; do not interchange them. Omit trailing slashes.

Generate a shared upload secret:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Put it in `.env` as `INGEST_SHARED_SECRET` and retain it for the next step. Do not commit secrets.

Official references: [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) and [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

## 4. Choose the upload service

If you are not modifying Ingest, you can [deploy it normally](LOCAL.md#cloudflare), set `INGEST_BASE_URL` to its HTTPS URL, use the same shared secret, and add `http://localhost:8000` to the deployed Worker's and R2's origins. Do not create a local `wrangler.toml` in this development checkout; `pnpm dev` will then skip local Ingest, which is expected for this option. Verify uploads against the actual deployed URL.

Only follow the local steps below, using `8787`, when you need to change or debug Ingest.

### Configure local Ingest and media processing

```bash
cp packages/ingest/wrangler.toml.template packages/ingest/wrangler.toml
cp packages/ingest/.dev.vars.template packages/ingest/.dev.vars
pnpm --filter @breatic/ingest exec wrangler login
pnpm --filter @breatic/ingest exec wrangler whoami
```

Complete browser authorization and confirm the account owns your bucket. With multiple accounts, set `account_id = "YOUR_ACCOUNT_ID"` at the top of `wrangler.toml`.

Replace **every angle-bracket placeholder** in `packages/ingest/wrangler.toml`. Invalid numeric placeholders in the production section still prevent TOML parsing even when running locally.

| Setting | Local-development value |
| --- | --- |
| Top-level `[[r2_buckets]].bucket_name` | Exactly the root `.env`'s `R2_BUCKET` |
| Top-level `[[r2_buckets]].remote` | Keep `true` |
| Top-level `[[containers]].max_instances` | Integer `5`, unquoted |
| `[dev].port` | Integer `8787` |
| `[vars].ALLOWED_ORIGINS` | `"http://localhost:8000"` |
| `[env.production.vars].ALLOWED_ORIGINS` | For this local-only setup, fill with `"http://localhost:8000"` to complete the template |
| `[[env.production.r2_buckets]].bucket_name` | For this local-only setup, use the same development bucket |
| `[[env.production.containers]].max_instances` | Integer `5` |

Keep both `image_build_context = "../.."` lines and the template's `compatibility_date`, Durable Object bindings and `exports`. Filling production fields here only makes the template valid; **this local workflow does not run `deploy:worker`**. For a deployed upload service, configure cloud resources using the [Cloudflare deployment steps](LOCAL.md#cloudflare).

Edit `packages/ingest/.dev.vars`:

```dotenv
INGEST_SHARED_SECRET=YOUR_GENERATED_SECRET
```

The secret must exactly match the root `.env`. Do not put bucket, port or CORS settings in `.dev.vars`.

`remote = true` makes the local Worker write to real R2. Without it, files land in simulated local storage while the application still reads from public R2 URLs, resulting in missing assets. See [R2 Worker local development](https://developers.cloudflare.com/r2/get-started/workers-api/).

## 5. Configure AI capabilities

Set your `OPENROUTER_API_KEY` in `.env` and confirm access and quota for the configured models. Text routing prefers a configured vendor's direct key and otherwise uses OpenRouter. Leave unused `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY` and `DEEPSEEK_API_KEY` empty.

One text key does not cover every image, video, audio, speech or 3D provider. For the models you want to use, find `api_key_env` in `config/models/<type>/providers.yaml` and set that variable. WaveSpeed models, for example, need `WAVESPEED_API_KEY`. Unconfigured providers are outside your current acceptance checks.

Google sign-in, real SMTP email, Stripe and Brave search are optional integrations. Configure them in the relevant `.env.dev` sections when needed. Enabling `PAYMENT_ENABLED` does not solve model-provider quota issues.

## 6. Start databases and run both migrations

After the root `.env` exists:

```bash
docker compose up -d postgres redis
docker compose ps postgres redis
```

Wait for both services to report `healthy`. **Keep `postgres redis` in the command**; omitting them starts the separate GHCR-image deployment stack.

For a fresh volume, initialization creates both `breatic` and `breatic_yjs`. Check:

```bash
docker compose exec postgres psql -U breatic -d postgres -c '\l'
```

If an older volume lacks `breatic_yjs`, create it only after confirming its absence:

```bash
docker compose exec postgres psql -U breatic -d postgres -c 'CREATE DATABASE breatic_yjs;'
```

Build the packages imported by the migration script before migrating:

```bash
pnpm exec turbo run build --filter=@breatic/core...
pnpm db:migrate
pnpm db:check-watermark
```

Migration should report business-database success followed by Yjs-database success and exit successfully. The watermark check must also succeed. Running only `pnpm install` before migrating fails because `packages/core/dist/index.js` has not been built.

These steps target a new database. Back up existing data before upgrading. For historical migration-timestamp problems, read the report from `pnpm db:journal-repair` before deciding to repair; do not experiment with existing migration records.

## 7. Start the application

Keep Docker running and execute from the repository root:

```bash
pnpm dev
```

Leave the terminal open. The command builds dependencies and starts web, API, background jobs, collaboration and, when configured, local Ingest. The first local Ingest start downloads base images and builds the media container; duration depends on connectivity and hardware.

If you chose local Ingest but see `ingest Worker: no wrangler.toml here`, complete section 4. Developers using deployed Ingest need no local Worker. Do not use `--enable-containers=false` when validating video metadata and covers.

Open **http://localhost:8000**. Do not mix `localhost` and `127.0.0.1`; cookies and CORS origins differ. Register your own account, complete your personal Studio/handle setup and create a project. There is no shared default administrator account or login bypass.

## 8. Verify actual behavior

From another terminal in the same checkout:

```bash
curl --fail http://localhost:3001/healthz
curl --fail http://localhost:9101/healthz
curl --fail http://localhost:1235/healthz
curl --fail --output /dev/null http://localhost:8000
curl --fail -i -X OPTIONS http://localhost:8787/ \
  -H 'Origin: http://localhost:8000' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: x-upload-token,content-type'
```

If using deployed Ingest, substitute its URL for `http://localhost:8787/`. The first three probes should return HTTP 200, the web page should load, and upload preflight should allow `http://localhost:8000`. Preflight checks reachability and the allowed origin, not secrets, R2 bindings or successful writes; actual uploads verify those.

In the browser:

- [ ] Register, sign out and sign back in; create and reopen a project.
- [ ] In that project, create a Document Space and two Canvas Spaces, give them distinct names and switch between them. Write a short script in the document and add content to both canvases; reload and confirm that each Space retains its own content.
- [ ] Open the same Space in two tabs, edit and see synchronized changes; reload and confirm persistence. Repeat for both Canvas and Document Spaces.
- [ ] Upload an image, reload and complete a crop operation.
- [ ] Upload a short video and check its cover, media information and playback.
- [ ] Send a text-model message and receive a complete response.
- [ ] Complete a generation using a configured model; its result appears and remains after reloading.

A feature is verified only when its check succeeds. Healthy services do not prove valid storage credentials, model keys or quota.

With `pnpm dev` still running in another terminal, install browser dependencies and run the default checks:

```bash
pnpm typecheck
pnpm test
pnpm --filter @breatic/web exec playwright install chromium
pnpm --filter @breatic/web test:smoke
pnpm --filter @breatic/web test:visual
```

On Linux, install missing browser system libraries as Playwright directs. Run the two browser suites sequentially, not concurrently. The default suites omit external-model/storage scenarios and do not replace manual checks above. See [Test requirements](../docs/TEST-MANDATE.md).

## 9. Stop, restart and update

Stop the application with `Ctrl+C` in the `pnpm dev` terminal. Stop this checkout's infrastructure:

```bash
docker compose stop postgres redis
```

Start again:

```bash
docker compose up -d postgres redis
pnpm dev
```

These commands affect local processes, not a deployed Cloudflare Worker. Databases live in Docker named volumes and assets in R2. Stopping processes does not delete them. **Do not use `docker compose down -v`**, which deletes this project's database volumes. Restart `pnpm dev` after environment or Ingest configuration changes.

Before updating, stop the application and back up both databases while their container remains running. Timestamped filenames avoid overwriting older backups:

```bash
mkdir -p backups
backup_stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U breatic -Fc breatic > "backups/breatic-${backup_stamp}.dump"
docker compose exec -T postgres pg_dump -U breatic -Fc breatic_yjs > "backups/breatic_yjs-${backup_stamp}.dump"
```

Check command success, keep backups somewhere safe and do not commit them. These dumps do not include R2 files. For a Git checkout:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@breatic/core...
pnpm db:migrate
pnpm db:check-watermark
pnpm dev
```

ZIP users should download the new source and preserve their `.env`, Ingest configuration and secrets. Keep the directory name/location consistent: changing the default Compose project name can make old data appear missing by selecting new volumes. Repeat section 8 after upgrading. Reverting source alone does not guarantee rollback after database migrations.

## 10. Troubleshooting

| Symptom | Check or action |
| --- | --- |
| pnpm ignores overrides/patches or rejects the lockfile | Require version 9.15.0; do not delete the lockfile or upgrade dependencies to bypass the error |
| Docker has only Client information | Start the daemon/Desktop and check WSL integration |
| Address already in use | Check section 2's ports; stop conflicting instances or update ports and all matching origins together |
| Missing `core/dist/index.js` | Run the dependency build in section 6 |
| Missing `breatic_yjs`, tables or columns | Check both database URLs and run both migrations and the watermark check |
| Database password mismatch | Existing volumes keep their original password; editing the template does not change it |
| Wrangler cannot parse configuration | Replace all placeholders, especially both `max_instances` values and `[dev].port`; numbers are unquoted |
| Wrangler cannot access R2 | Check `wrangler whoami`, account ID and bucket ownership; S3 credentials do not replace Wrangler authorization |
| Upload returns 401 | Match the two shared secrets and restart |
| Upload CORS error | Match Ingest's origin to the page exactly, with no trailing slash |
| Uploaded file returns 404 | Check `remote=true`, matching buckets, public access and `UPLOAD_BASE_URL` |
| Images display but cropping fails | Configure GET CORS on the R2 public endpoint, not just upload CORS |
| Video has no cover or media image build fails | Inspect Ingest output, Docker, downloads and build context; do not disable the container |
| ffmpeg/ffprobe not found | Verify both commands in the same terminal used for `pnpm dev` |
| Model credentials/quota errors | Check the selected provider, clear unused fake keys and inspect API/Worker logs |
| Login returns to the sign-in screen | Keep `ENV=dev`, empty `COOKIE_DOMAIN` and consistent `localhost:8000` access |
| No email arrives | Console mode only prints logs; delivery needs SMTP |

Infrastructure logs: `docker compose logs --tail=100 postgres redis`. For application logs, start with the `pnpm dev` terminal and `logs/`. Remove secrets, cookies and signed upload tokens before sharing logs.
