// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `pnpm dev` with every mail caught by a local Mailpit.
 *
 * Starts the Mailpit container, then runs the dev stack with SMTP_* pointed
 * at it for this process only. `.env` is left as it is: the servers load it
 * with dotenv, which keeps a value already in the environment, and turbo
 * passes these keys through (`globalPassThroughEnv`). The smoke suite reads
 * sign-up codes from the inbox at http://127.0.0.1:${MAILPIT_HTTP_PORT}.
 */

import { spawn, spawnSync } from "node:child_process";

import { findRoot, loadEnv } from "./load-env.js";

const DEFAULT_SMTP_PORT = "1025";

const root = findRoot();
loadEnv(root);

const up = spawnSync("docker", ["compose", "--profile", "dev", "up", "-d", "mailpit"], {
  cwd: root,
  stdio: "inherit",
});
if (up.status !== 0) {
  console.error("Could not start Mailpit (`docker compose --profile dev up -d mailpit`).");
  process.exit(up.status ?? 1);
}

const dev = spawn("pnpm", ["dev"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    EMAIL_BACKEND: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: process.env.MAILPIT_SMTP_PORT || DEFAULT_SMTP_PORT,
    // Mailpit accepts any login (MP_SMTP_AUTH_ACCEPT_ANY in docker-compose.yml).
    SMTP_USER: "dev",
    SMTP_PASSWORD: "dev",
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => dev.kill(signal));
}
dev.on("exit", (code) => process.exit(code ?? 0));
