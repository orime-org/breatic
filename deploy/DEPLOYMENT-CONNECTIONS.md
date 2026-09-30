# Frontend and managed Redis connections

The local deployment keeps same-origin `/api/v1` and `/ws` defaults. A frontend hosted separately from the backend can override them at build time:

```ini
VITE_API_BASE_URL=https://backend.example.com/api/v1
VITE_COLLAB_URL=wss://backend.example.com/ws
```

These are public addresses, never secrets. Vite embeds them in the bundle; changing the backend container environment does not update an already built frontend. Dockerfile.web accepts the same names as build arguments. Turbo includes the values in the build cache key. The API base includes `/api/v1`; a trailing slash is removed. Axios, text SSE, agent chat and download links all use the same base. Collab's shared socket and document providers use the configured WS URL.

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

## Scope and verification

This change implements the user-approved separate-frontend deployment without changing database tables, session format, task semantics or local deployment defaults. Keeping one configurable API base avoids divergent request paths; passing queue TLS/credentials fixes the lost connection options rather than weakening cloud security. Separate API and WS hostnames would require a different cookie-sharing decision and are not required.

Verify both empty/default and explicit frontend settings; authenticated Redis with TLS, special-character credentials and untrusted-certificate rejection; cross-origin credentialed HTTP requests; and authenticated collaboration. Registration-verification policy remains a separate feature.
