# Frontend and managed Redis connections

The local deployment keeps same-origin `/api/v1` and `/ws` defaults. A frontend hosted separately from the backend can override them at build time:

```ini
VITE_API_BASE_URL=https://backend.example.com/api/v1
VITE_COLLAB_URL=wss://backend.example.com/ws
```

These are public addresses, never secrets. Vite embeds them in the bundle; changing the backend container environment does not update an already built frontend. Dockerfile.web accepts the same names as build arguments. Turbo includes the values in the build cache key. The API base includes `/api/v1`; a trailing slash is removed. Axios, text SSE and agent chat all use the same base. Download links do not: they are the file's own address under `UPLOAD_BASE_URL` with `download=1` appended. Collab's shared socket and document providers use the configured WS URL.

Set `ALLOWED_ORIGINS` to the frontend's exact origin, for example `https://example.com`. Ordinary API and streaming clients send credentials. With API and WS on the same backend hostname, leave `COOKIE_DOMAIN` empty: the host-only session cookie belongs to that backend, not to the frontend. This arrangement assumes HTTPS frontend/backend hosts on the same site; an unrelated frontend domain has different browser cookie restrictions and is not this deployment contract.

Collab checks any browser-supplied Origin against the same allowlist before session lookup, regardless of throttle settings. Non-browser clients without an Origin still require a valid session and project membership. CORS is not a replacement for business authorization. Password-reset, email-verification, invitation and transfer links select an allowed request origin, falling back to the first configured HTTP origin when absent or untrusted. Google sign-in exchanges an ID token rather than using a backend redirect callback; register the actual frontend origin with Google.

## Managed Redis

Keep the four existing URL variables and logical databases:

| Variable | Database | Role |
|---|---|---|
| `REDIS_URL` | 0 | Sessions, locks and limits |
| `REDIS_QUEUE_URL` | 1 | BullMQ queues and workers |
| `REDIS_STREAM_URL` | 2 | Cross-service events |
| `REDIS_COLLAB_URL` | 3 | Collaboration coordination |

Use `rediss://<username>:<encoded-password>@<private-host>:<tls-port>/<db>` for TLS and ACL authentication. Password-only services may omit the username. Percent-encode credentials; do not encode the entire URL. The queue now passes TLS and decoded credentials to Queue, QueueEvents and Worker connections, matching the URL support already provided by the shared ioredis factory. Local `redis://` without credentials remains supported.

TLS uses normal certificate verification; do not disable it. If the provider requires a private CA, mount that CA and configure the Node process trust store (for example `NODE_EXTRA_CA_CERTS`) before starting every affected service. No separate `REDIS_PASSWORD` variable is introduced. Keep Redis private and use `noeviction`; select a service supporting the existing logical databases and commands. Redis Cluster cannot be substituted for this configuration just by changing the hostname.

## SMTP sender

With `EMAIL_BACKEND=smtp`, `SMTP_USER` and `SMTP_PASSWORD` authenticate to the relay. Set `SMTP_FROM` to a verified sending address, optionally including a display name, such as `Breatic <noreply@example.com>`. It controls the message From header and Nodemailer's default envelope sender; it does not change the login username. Surrounding whitespace is removed. Missing or blank values preserve the previous behavior of using `SMTP_USER`, which is only suitable when that username is itself a valid sending address.

This is a backend runtime setting: update every email-sending service and recreate its container. Existing `.env` files containing the old sample `noreply@example.com` must be replaced with a verified address or cleared before upgrading; that previously ignored value now takes effect. The disabled and console backends are unchanged. This setting neither verifies a sender with your provider nor enables mandatory registration verification.

## Project release notice

For a versioned production build, set the existing `VITE_APP_VERSION` to a unique release identifier (1–128 letters, digits, dots, underscores or hyphens). Publish `/app-version.json` on the **frontend origin**, with `{"version":"<the same identifier>"}`, atomically with that bundle. Serve the manifest with `Cache-Control: no-store`, keep HTML revalidated, and retain previous hashed assets while old tabs remain open. The internal Cloudflare frontend release scripts already assemble this manifest; a standalone web build does not generate it.

Only Project checks it, initially and approximately every 3–3.5 minutes while visible. Foreground checks are throttled to 30 seconds. Development builds and builds without a valid release identifier do not poll. Missing, invalid or unreachable manifests are ignored. A different identifier, including a rollback, offers a neutral top-bar notice without opening its popover or reloading. Later hides that release for the tab session.

The Update button reloads the page using the existing Project `beforeunload` guard: uploads and other registered browser operations show context in the popover and may trigger the native browser leave confirmation. No CRDT save, flush or persistence acknowledgement is added. Refresh never runs automatically, including after an upload finishes. Connection errors take priority over the notice.

No environment variables are added or removed. Changing `VITE_APP_VERSION` requires rebuilding the frontend, not restarting the backend.

## Product analytics (off by default)

A self-hosted instance sends nothing to any analytics or advertising service. With every variable below empty, the backend never starts an analytics client, the ad-conversion queue stays empty, and the web build contains no Amplitude, Google tag or consent-banner code. The hosted service at breatic.ai sets them; you only need this section to measure your own instance with your own accounts.

| Variable | Where it is read | Turns on |
|---|---|---|
| `AMPLITUDE_API_KEY` | server, worker, collab at startup | Server-side product events (sign-up, project and Space creation, first generation, invitations, purchases, subscriptions) |
| `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_CONVERSION_ACTIONS`, `GOOGLE_DATA_MANAGER_CREDENTIALS` | server, worker, collab at startup | Server-side Google Ads conversion upload through the Data Manager API. Set all three or none; a partial or malformed set leaves uploads off and logs `google_ads_config_invalid` |
| `VITE_AMPLITUDE_API_KEY` | web build | Browser product events and the consent banner |
| `VITE_GOOGLE_ADS_TAG_ID`, `VITE_GOOGLE_ADS_CONVERSION_LABELS` | web build | The Google tag and browser conversions, deduplicated with the server upload by transaction id |
| `VITE_CONSENT_COOKIE_DOMAIN` | web build | Where the `breatic_consent` cookie is written; empty means the current host |

The `VITE_*` values are embedded in the bundle like the connection settings above: changing them means rebuilding the frontend, not restarting a container. Dockerfile.web accepts them as build arguments. When the pages and the API sit on two subdomains, set `VITE_CONSENT_COOKIE_DOMAIN` to the parent domain they share (for example `example.com`), so the API and collab read the visitor's choice; the backend `COOKIE_DOMAIN` stays empty.

The consent choice lives in a cookie the banner library writes from script, so browsers apply their own limits to it: Safari and the other browsers on iPhone and iPad delete it after 7 days without interaction on the site (24 hours when it was written on a page reached from an ad link), and Brave 180 days after it was written. The visitor is then asked again, or the rule for their region applies.

What leaves when it is on:

- Only after consent. Visitors in the EEA, the UK, Switzerland and mainland China are asked first; elsewhere both categories start on and can be turned off. A browser sending Global Privacy Control starts with advertising off; a visitor who turns advertising on in the banner or Cookie settings is followed. Backend events follow the choice of the browser that caused them.
- The account keeps the latest report. A signed-in browser sends its choice to `PUT /api/v1/users/me/consent` after sign-in and after each change; the account keeps only the latest one and never sends it back to a browser. Events without a browser (renewals, completed refunds, a collaborator's first action in an owner's project) follow that report and are not sent for an account that never reported.
- Only listed properties. Every event passes a per-event allowlist in `@breatic/shared`; prompts, document text, file names, email addresses and session ids never leave. URLs are reduced to their path. Session Replay is not installed.
- Only to the accounts you configure. Events go to your Amplitude project in its US data centre and conversions to your Google Ads customer.

To turn it off again, empty the variables, restart the backend and rebuild the frontend.

When you delete an account on request, soft-delete it first (set `users.deleted_at`), then run `pnpm analytics:delete-users <users.id> …` from the repository root. The command refuses any account that is not soft-deleted and lists those ids. It clears the account's latest consent report and the consent kept on its orders, upload tickets and ad uploads. When `AMPLITUDE_API_KEY` is set, pass `AMPLITUDE_SECRET_KEY=<project secret key>` for that run and the command also asks Amplitude to delete the account's events; the secret key is in the Amplitude project's settings, Amplitude schedules the deletion within 30 days and the command prints the scheduled day. Without `AMPLITUDE_API_KEY` it says there is nothing to delete at Amplitude and stops. How long Amplitude keeps events is set in its organization settings (Time to Live).

## Back office internal API

`INTERNAL_API_ENABLED=true` starts a second server listener, called only by the Breatic back office, on `INTERNAL_API_HOST`:`INTERNAL_API_PORT` (default `127.0.0.1:3002`), plus the loop that finishes the credit-pack refunds it accepts. Every request carries an HMAC-SHA256 signature made with `INTERNAL_API_SECRET`, the same value the back office holds; with the API enabled and that secret empty, the services refuse to start. To rotate, move the old key to `INTERNAL_API_SECRET_PREVIOUS`: requests signed with either key are accepted until it is blanked. Requests are limited to 120 per 60 seconds per connection address (`internal-api` in `config/rate-limits.yaml`).

| Deployment | Product server | Back office connects to |
|---|---|---|
| Local development | Binds `127.0.0.1:3002` | `http://127.0.0.1:3002` |
| This `docker-compose.yml` | Binds `0.0.0.0` in the container; `expose: ["3002"]` only, no host port | `http://server:3002`, from a container on the same compose network |
| Separate hosts in one VPC | Binds `0.0.0.0` in the container; publish `<private-ip>:3002:3002` | `http://<product private IP>:3002` |

With separate hosts, the security group is the only network-level isolation: on Alibaba Cloud ECS, traffic to the public IP is translated to the primary private IP, and Docker-published ports bypass the host firewall. Allow inbound 3002 only from the back office server's private IP/32, and keep the product host's group free of intra-group allow rules (or use an enterprise security group). Make every deployment's verification probe 3002 from the public IP, and fail the deployment if the connection succeeds.

Subscribe the product's Stripe webhook endpoint to `refund.created`, `refund.updated` and `refund.failed`.

| Stripe access | What it needs |
|---|---|
| `STRIPE_SECRET_KEY` | Refunds are created (`refunds.create`) and listed (`refunds.list`); the preview and restoring credits also read `paymentIntents.retrieve` with `expand: ["latest_charge"]` for the charge's `disputed`. A restricted key needs write on Refunds and read on PaymentIntents and Charges. |
| Operators' and support staff's Stripe Dashboard accounts | No refund permission: a read-only role, or a custom role without "Process refunds". A credit pack is refunded in full or not at all, only through the back office; a refund made in the Dashboard is never booked automatically, and the disposition that meets it stops for a person. |

The back office reads the refund records through its own read-only role: the five tables and the two views migration `0094` adds (`credit_refunds_unresolved_failed`, `credit_lot_refund_failures`). That role gets SELECT on new tables and views through `ALTER DEFAULT PRIVILEGES` bound to the role that runs the product's migrations (see the back office's deployment notes). If `0094` ran as a different role, grant SELECT on those five tables and two views to the back office role by hand.

## Scope and verification

This change implements the user-approved separate-frontend deployment without changing database tables, session format, task semantics or local deployment defaults. Keeping one configurable API base avoids divergent request paths; passing queue TLS/credentials fixes the lost connection options rather than weakening cloud security. Separate API and WS hostnames would require a different cookie-sharing decision and are not required.

Verify both empty/default and explicit frontend settings; authenticated Redis with TLS, special-character credentials and untrusted-certificate rejection; cross-origin credentialed HTTP requests; and authenticated collaboration. Registration-verification policy remains a separate feature.
