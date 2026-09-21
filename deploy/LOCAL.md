# Personal and LAN deployment

**English** | [简体中文](LOCAL-CN.md)

Use this guide to run Breatic for yourself or share it with your household, private group or colleagues within one organization. Install the application on one computer; other users connect through a browser. **Use published images, not development servers.** For source changes, see [Development setup](DEVELOPMENT.md).

The [LICENSE](../LICENSE) permits individual use, private groups that are not publicly advertised or open to general sign-up, and internal organizational use. Without separate authorization, offering Breatic to the public is prohibited, whether paid or free. Limit LAN access to your permitted group as well.

## 1. What you will run

```text
Local / LAN browser -> Host nginx -> API, collaboration, background jobs
                                      -> PostgreSQL + Redis
Browser uploads ----> Deployed Cloudflare Ingest Worker -> R2
API / background jobs -> Ingest Worker / AI providers
```

Docker Compose runs the application and databases on your host. The Ingest Worker and media container are deployed to **your Cloudflare account** and keep running independently of the terminal used to deploy them. Both the host and browsers need access to the upload and asset-read URLs.

This is not an offline installation: storage requires R2 and generation uses external models. Normal use does not require `pnpm dev`, `wrangler dev` or port `8787`. Initial cloud provisioning currently uses Node/pnpm/Wrangler to publish the matching components once; this is a deployment step, not an ongoing development session.

## 2. Prerequisites and versions

- Install and start Docker Engine or Docker Desktop with Compose v2. The GHCR `main` images inspected for this guide publish only `linux/amd64`. This installation path targets x86-64 hosts: Linux, Intel Macs, or x86-64 Windows/WSL2. Do not assume native Apple Silicon/ARM support; use a matching ARM release when available or separately validate emulation. On Windows, run the commands in a WSL2 terminal with Docker Desktop integration enabled.
- Allow access to GitHub, GHCR, container registries, Cloudflare and the model providers you need.
- Enable R2 and ensure your Cloudflare account can use Containers. Check the [Cloudflare prerequisites](https://developers.cloudflare.com/containers/get-started/) for plan and billing requirements.
- Prepare your own model API keys and quota. Text chat needs a text provider; media generation needs the selected model's provider.
- On the machine publishing cloud components, install Node.js 22.x and pnpm 9.15.0. This can be the application host or a separate computer. Docker must run while building the media container.
- Start single-computer use at `http://localhost`. For LAN sharing, use a fixed private IP and HTTPS trusted by every client; see section 7.

Check your tools:

```bash
docker version
docker compose version
node --version
npm install --global pnpm@9.15.0
pnpm --version
```

Docker must report a Server, Node should report `v22...`, and pnpm must report `9.15.0`. The repository does not yet provide a verified minimum hardware specification. Monitor CPU and memory with `docker stats`, and size resources for your workload and concurrency.

Download the complete repository and enter its root:

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
cp .env.docker .env
```

Alternatively, extract the source ZIP and enter the directory containing `docker-compose.yml`, `Dockerfile` and `package.json`. Run subsequent commands from that root. Do not overwrite an existing `.env`.

**Keep versions together.** Application images, Ingest source and deployment configuration should come from the same release. `BREATIC_TAG` selects both application image tags; confirm that both exist before selecting a release. Do not invent a version number. `main` and `latest` move over time and are suitable for evaluation, not a reproducible release. When evaluating branch images, record their actual digests and the source commit. Editing local configuration does not update files already baked into an image.

## 3. Configure the application

Edit existing entries in `.env`, keeping one definition per key. For an initial HTTP installation accessible only from this computer:

```dotenv
BREATIC_TAG=main
WEB_BIND_ADDRESS=127.0.0.1
ENV=dev
COOKIE_DOMAIN=
ALLOWED_ORIGINS=http://localhost
PAYMENT_ENABLED=false
EMAIL_BACKEND=console
REDIS_KEY_PREFIX=personal
```

In the current application, `ENV=dev` permits session cookies over HTTP. **It does not start development servers**: these containers still run compiled application code. Use `ENV=prod` after switching to HTTPS. Disabling payments does not eliminate external AI charges. `console` writes email to logs rather than delivering it. Real email, Google sign-in, Stripe and search can be configured separately using the template.

Keep container-internal connection addresses:

```dotenv
DATABASE_URL=postgres://breatic:breatic@postgres:5432/breatic
YJS_DATABASE_URL=postgres://breatic:breatic@postgres:5432/breatic_yjs
REDIS_URL=redis://redis:6379/0
REDIS_QUEUE_URL=redis://redis:6379/1
REDIS_STREAM_URL=redis://redis:6379/2
REDIS_COLLAB_URL=redis://redis:6379/3
```

**Do not replace these hosts with `localhost`**: inside an application container, localhost means that container itself. Keep the template's internal application ports. The web entry point defaults to loopback, as do the database, Redis and API host ports. LAN clients should reach the application through nginx only.

Replace sample provider keys with your own valid keys; leave unused keys empty. `OPENROUTER_API_KEY` supplies the text-model route when no direct vendor key is configured, subject to model availability and account quota. For image, video and other providers, use the `api_key_env` named in `config/models/<type>/providers.yaml`; WaveSpeed models, for example, need `WAVESPEED_API_KEY`.

<a id="cloudflare"></a>
## 4. Deploy the Cloudflare upload service

### 4.1 Create storage and an asset-read URL

Create a dedicated R2 bucket, such as `creator-assets-personal`. Create **Object Read & Write** S3 credentials scoped to that bucket, and save the Access Key ID, Secret Access Key and S3 endpoint. Do not share another installation's production bucket.

For local evaluation, enable the bucket's Public Development URL and copy its `https://pub-....r2.dev` address. The word Development here describes Cloudflare's public read endpoint, not a local Worker. For sustained use, connect your own asset domain; `r2.dev` has usage limits. See [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Assets are currently read through public URLs. A private Breatic instance does not automatically make R2 files private. Do not put files requiring authenticated access into this public-read setup.

Save the following bucket CORS configuration:

```json
[
  {
    "AllowedOrigins": ["http://localhost"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

R2 GET CORS enables asset reads and image cropping. The upload Worker has a separate origin setting; maintain both. See [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

### 4.2 Prepare the deployment configuration

On the publishing machine, in the matching source checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter @breatic/ingest exec wrangler login
pnpm --filter @breatic/ingest exec wrangler whoami
```

Confirm that you logged into the account owning the bucket. Create `packages/ingest/wrangler.toml` with this deployment-only configuration, replacing the account ID and bucket name. Git ignores this file. If you already have a development configuration, back it up first; do not merge the two configurations.

```toml
name = "creator-ingest-config"
main = "src/index.ts"
compatibility_date = "2026-03-10"
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"

[env.production]
name = "creator-ingest-personal"
workers_dev = true

[env.production.vars]
ALLOWED_ORIGINS = "http://localhost"

[[env.production.r2_buckets]]
binding = "BUCKET"
bucket_name = "creator-assets-personal"

[[env.production.containers]]
class_name = "MediaContainer"
image = "./Dockerfile"
image_build_context = "../.."
max_instances = 5

[[env.production.durable_objects.bindings]]
name = "MEDIA"
class_name = "MediaContainer"

[env.production.exports.MediaContainer]
type = "durable-object"
storage = "sqlite"
```

For multiple instances in one Cloudflare account, give each a distinct production `name`, bucket and shared secret. Do not overwrite an existing Worker. This deployment configuration has no `[dev].port`, `remote=true` or `.dev.vars`.

Generate and securely save a random shared secret:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Store it in Cloudflare by pasting the generated value when prompted:

```bash
pnpm --filter @breatic/ingest exec wrangler secret put INGEST_SHARED_SECRET --env production
pnpm --filter @breatic/ingest deploy:worker
```

If the first secret command asks to create a missing Worker, confirm that its name is the new instance you intend to create. Initial deployment builds and uploads the media container and prints the actual Worker HTTPS URL. Use that output, for example `https://creator-ingest-personal.YOUR_SUBDOMAIN.workers.dev`; do not guess your account subdomain. See [Deploy Containers](https://developers.cloudflare.com/containers/guides/deploy/).

If Containers access, image building or deployment fails, resolve the error. Disabling the media container does not produce a complete upload setup.

### 4.3 Connect the application

On the application host, fill in the root `.env`:

```dotenv
STORAGE_PROVIDER=r2
R2_BUCKET=creator-assets-personal
R2_ACCESS_KEY=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_KEY=YOUR_R2_SECRET_ACCESS_KEY
R2_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
UPLOAD_BASE_URL=https://pub-YOUR_PUBLIC_BUCKET_ID.r2.dev
INGEST_BASE_URL=https://creator-ingest-personal.YOUR_SUBDOMAIN.workers.dev
INGEST_SHARED_SECRET=YOUR_GENERATED_SECRET
```

Replace every `YOUR_...` value. The shared secret must exactly match the Cloudflare secret, and both sides must name the same bucket. Do not interchange the public read URL and S3 endpoint. Omit trailing slashes from base URLs and never commit credentials.

The Worker does not need to call back into the local application. Personal use therefore does not require router port forwarding, a tunnel or a public domain for the application.

## 5. Start the application

Complete sections 3 and 4 first. Ensure ports 80, 443, 5432, 6379 and 3000 are not occupied by another service, then run:

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps -a
docker compose logs --tail=100 migrate
```

Startup order is infrastructure health, migrations for both databases, application services, then web. A successful `migrate` exit (`Exited (0)`) is expected; it is not a long-running service. Other services should run, with server, collab, worker, postgres and redis healthy.

Open **http://localhost**, register your own account, save the recovery code and complete your personal Studio setup. Do not bypass a failed migration to start the application.

For an older PostgreSQL volume missing the second database, confirm that it is absent before creating it:

```bash
docker compose exec postgres psql -U breatic -d postgres -c '\l'
# Only when breatic_yjs is absent:
docker compose exec postgres psql -U breatic -d postgres -c 'CREATE DATABASE breatic_yjs;'
docker compose up -d
```

An existing volume keeps the database password set during its initial creation. Editing the template does not change that database user's password.

## 6. Verify the complete installation

- [ ] `docker compose ps -a` shows a successful migration and running, healthy services.
- [ ] Register, sign out and sign back in; create and reopen a project.
- [ ] In that project, create a Document Space and two Canvas Spaces, give them distinct names and switch between them. Write a short script in the document and add content to both canvases; reload and confirm that each Space retains its own content.
- [ ] Upload an image, reload the page and crop a region successfully.
- [ ] Upload a short video and verify its cover, media information and playback.
- [ ] Open the same Space in two tabs or two authorized users' browsers; edits synchronize. Check both a Canvas Space and a Document Space.
- [ ] Receive a text-model response and complete one generation with a configured media model; its result appears on the canvas.
- [ ] Restart the application; projects, uploads and generated results remain readable.

There is no local `8787` check in this workflow. Healthy application probes do not validate cloud storage or model access; perform actual uploads and generation.

## 7. Share with people on your LAN

Use the same containers; each user needs only a browser. Give the host a fixed private IP, such as `192.168.1.50`. Other devices cannot reach it using `localhost`, which points to each device itself.

### 7.1 Set up trusted HTTPS

An HTTP page on a LAN IP does not receive localhost's secure-context exception; browser capabilities such as clipboard access can be restricted. Use trusted HTTPS for LAN access. Bypassing a certificate warning is not a completed certificate setup.

For a household or small team, install mkcert following its [official instructions](https://github.com/FiloSottile/mkcert), then create a local CA and certificate:

```bash
mkcert -install
mkdir -p docker/certs
mkcert -cert-file docker/certs/cert.pem -key-file docker/certs/cert.key localhost 127.0.0.1 ::1 192.168.1.50
mkcert -CAROOT
```

Replace the example IP with the host's fixed address. `mkcert -install` trusts the CA only on this computer. On every other client, install and trust **`rootCA.pem`** from the printed CA directory according to that operating system/browser's instructions. Verify that the browser shows no certificate warning. **Never distribute `rootCA-key.pem` or the site's private key.** Organizations should use their own CA trusted by clients. Certificates must cover the actual IP or domain; reissue them when addresses change.

### 7.2 Update all origins

Change the application's `.env`:

```dotenv
WEB_BIND_ADDRESS=0.0.0.0
ENV=prod
COOKIE_DOMAIN=
ALLOWED_ORIGINS=https://192.168.1.50,https://localhost
```

`0.0.0.0` listens on all IPv4 interfaces. Restrict ports 80/443 to your trusted LAN in the host firewall and do not forward them from the public Internet. To use just one interface, set `WEB_BIND_ADDRESS` to its private IP instead.

Set `[env.production.vars].ALLOWED_ORIGINS` in `wrangler.toml` to the same origin list and redeploy with `pnpm --filter @breatic/ingest deploy:worker`. Set R2 CORS `AllowedOrigins` to those two HTTPS origins as well. Match protocol, hostname and port exactly, with no trailing slash. You do not add every visitor's device IP: these are the origins of the application page.

Recreate application containers to load `.env` changes and let nginx select the certificate configuration:

```bash
docker compose up -d --force-recreate server collab worker web
```

Everyone visits **https://192.168.1.50**. Repeat login, upload, cropping and collaboration checks from section 6 on another computer. After renewing certificate files, run `docker compose restart web`. An `.env` change requires container recreation; `restart` alone does not reload Compose environment values.

## 8. Daily operation, backups and upgrades

Stop with `docker compose stop`; start again with `docker compose up -d`. Docker and the host must remain running; LAN users lose access while the host sleeps. Stopping local services does not stop the cloud Worker or remove R2 objects.

Do not run `docker compose down -v`: it deletes the database volumes. Avoid changing the checkout directory name or Compose project name, which can make Compose use a different set of empty volumes.

Before upgrading, have users leave, wait for generation jobs to finish, then stop application writes and back up both databases:

```bash
docker compose stop web server worker collab
mkdir -p backups
backup_stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U breatic -Fc breatic > "backups/business-${backup_stamp}.dump"
docker compose exec -T postgres pg_dump -U breatic -Fc breatic_yjs > "backups/yjs-${backup_stamp}.dump"
```

Check that every command succeeds. Separately preserve `.env`, cloud configuration/secrets, certificates, the source version, both image digests and R2 object backups. Database dumps do not contain R2 files or unfinished queue jobs; do not claim a consistent snapshot while jobs are running. Do not commit `backups/`.

Read the target release's upgrade notes and obtain matching source and configuration, preserving your own settings. Publish the corresponding Ingest version, update `BREATIC_TAG`, then run:

```bash
docker compose pull
docker compose up -d
docker compose ps -a
```

Repeat section 6. If rollback requires database recovery, stop the application and restore the matching pair of databases, application version, Ingest version and configuration. Merely selecting an older image does not guarantee compatibility. Test recovery in an isolated instance before restoring over data in use.

## 9. Troubleshooting

| Symptom | Check or action |
| --- | --- |
| Image missing or no matching platform | Confirm both tags exist and support the host CPU; do not mix releases or assume an unpublished architecture is supported |
| Web fails or returns 502 | Read `docker compose logs --tail=100 web server collab`; check that the API service is `server` and the image matches the checked-out source version |
| Migration exits nonzero | Read migration logs; check both databases, credentials, versions and migration files; do not bypass it |
| Works locally but not from another device | Check the host IP, `WEB_BIND_ADDRESS`, firewall, host sleep and client certificate trust |
| HTTPS login loops | Use a trusted certificate, `ENV=prod`, an empty `COOKIE_DOMAIN` and one consistent address |
| Upload returns 401 | Match the application and Cloudflare shared secrets, then recreate application containers |
| Upload CORS error | Update the deployed Worker's origin list and redeploy; a LAN setup must not still name only localhost |
| Image returns 404 or cropping fails | Check the R2 bucket, public read URL and GET CORS; upload CORS does not replace read CORS |
| Video has no cover | Check the Cloudflare media container's deployment, runtime and logs; do not disable it |
| AI errors | Check the selected provider, credentials, quota and connectivity; the application payment switch cannot fix provider access |
| No email arrives | Console mode writes to `docker compose logs server`; real delivery needs SMTP |

On the publishing machine, inspect cloud logs with `pnpm --filter @breatic/ingest exec wrangler tail --env production`. Remove credentials, cookies and signed tokens before sharing logs.
