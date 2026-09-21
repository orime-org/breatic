# Private server and domain deployment

**English** | [简体中文](SERVER-CN.md)

Use this guide to run the same Breatic images on an internal server, a server behind a VPN, or a server restricted to a defined private group, using a fixed domain. For a personal computer or LAN, see [LOCAL.md](LOCAL.md). For source debugging, see [DEVELOPMENT.md](DEVELOPMENT.md).

## 1. Define who may access it

The repository's [LICENSE](../LICENSE), section 1, governs permitted use:

- Individual use, private groups that are not publicly advertised or open to general sign-up, and internal use within one organization are permitted.
- Offering the Breatic platform to the public without separate authorization is prohibited, **whether paid or free**.
- A server's location or possession of a domain does not determine whether access is public. This guide grants no additional license rights.

This guide assumes access is restricted through a VPN or private network. If the host has a public IP, restrict application access at the network boundary to the intended organization or private group. A login page alone is not an access boundary: a reachable registration endpoint may still accept strangers. For public-facing use, first contact [licensing@orime.ai](mailto:licensing@orime.ai) for appropriate authorization.

## 2. Reuse the installation workflow

Images, databases, migrations, Ingest and R2 work exactly as in a personal installation. Complete the software, version, Cloudflare deployment and configuration steps in [LOCAL.md sections 2–4](LOCAL.md), then apply the address and certificate changes below **before starting the application**. Do not start a local Wrangler server or use port `8787`.

Cloudflare can be deployed from an administrator's computer. The application server needs Docker/Compose and deployment files, not a long-running Node/pnpm session. Keep source, both application images and Ingest on matching versions.

## 3. Domain, DNS and certificates

Suppose you control `canvas.example.net`. Configure DNS to resolve it to a server address reachable from your clients' private network. Verify that clients can connect to the VPN, resolve the name and reach the address. Replace the example with your own domain; do not register names that violate the license's trademark terms.

Obtain a trusted HTTPS certificate covering that domain:

- An organization can use its internal CA, provided clients already trust it.
- For a public CA, its DNS-validation workflow can issue a certificate without exposing the application publicly. Configure issuance and automatic renewal through your organization's certificate tooling.

Place the full PEM certificate chain at `docker/certs/cert.pem` and the matching private key at `docker/certs/cert.key`. Restrict private-key access and do not commit it. nginx preserves the requested hostname instead of adding `www`; configure DNS, certificates and origins only for addresses you actually use.

The project does not obtain or renew certificates automatically. Set up expiry monitoring, scheduled renewal and `docker compose restart web` after renewal.

## 4. Use consistent application and cloud origins

In the application's `.env`:

```dotenv
WEB_BIND_ADDRESS=0.0.0.0
ENV=prod
COOKIE_DOMAIN=
ALLOWED_ORIGINS=https://canvas.example.net
PAYMENT_ENABLED=false
EMAIL_BACKEND=smtp
SMTP_HOST=YOUR_SMTP_HOST
SMTP_PORT=587
SMTP_USER=YOUR_SMTP_USER
SMTP_PASSWORD=YOUR_SMTP_PASSWORD
SMTP_FROM=YOUR_SENDER_ADDRESS
```

Replace SMTP placeholders with working values. If you intentionally do not need real email, choose `EMAIL_BACKEND=disabled` and preserve the recovery code provided during registration. Disabled mode does not send password-reset emails. Google OAuth, payments and other integrations are optional and configured separately.

You may bind `WEB_BIND_ADDRESS` to a specific VPN/private-interface IP. Restrict ports 80/443 to the intended networks in host firewalls and upstream security groups. Do not expose database, Redis or API ports to users.

Use your deployed HTTPS Ingest URL for `INGEST_BASE_URL`. Set its `[env.production.vars].ALLOWED_ORIGINS` to `https://canvas.example.net` and redeploy. Set R2 CORS `AllowedOrigins` to `["https://canvas.example.net"]`. For sustained use, provide an asset custom domain as `UPLOAD_BASE_URL` and check its CORS responses.

**Restricting the application does not protect public R2 asset URLs.** The current read path must not be described as private file hosting. If organizational policy requires authenticated file reads, this setup does not meet that requirement; CORS is not an access-control mechanism.

## 5. Start and verify

After completing the configuration, from the repository root:

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps -a
docker compose logs --tail=100 migrate
```

Once migrations exit successfully and the other services run, register and use the application at **https://canvas.example.net**. Complete login, uploads, cropping, video covers, collaboration, AI generation and persistence checks from [LOCAL.md section 6](LOCAL.md).

Also verify:

- [ ] Another authorized device on the VPN/private network works without certificate warnings.
- [ ] Clients outside the intended networks cannot reach the application, not merely its authenticated pages.
- [ ] Browser WebSocket collaboration and streamed chat responses work.
- [ ] If real email is configured, password-reset email is actually delivered.
- [ ] The asset domain is reachable from users and the server and returns the correct CORS headers.

This guide uses the repository's nginx to terminate HTTPS. If your environment has another reverse proxy, separately validate WebSocket, SSE, forwarded headers and TLS behavior. Do not blindly combine two sets of HTTPS redirect rules.

## 6. Operations

Follow the backup and upgrade procedure in [LOCAL.md](LOCAL.md), plus these requirements:

- Back up both databases, R2 objects and configuration regularly. Record matching image digests and Ingest versions, and practice isolated recovery.
- Monitor disk use, database connections, container health, model errors, Cloudflare containers and certificate expiry.
- Docker's `unhealthy` status does not restart a process. `restart: unless-stopped` handles process exits and restart policy; failed health checks need monitoring and intervention.
- Wait for jobs to finish and suspend writes before migrations and coordinated upgrades. Rollback must account for database compatibility, not just image tags.
- Establish the outer access boundary before allowing registration. New users must remain within the instance's permitted audience.

Complete verification before handing the instance to users.
