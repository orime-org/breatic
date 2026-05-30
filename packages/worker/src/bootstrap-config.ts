/**
 * Configuration bootstrap — the composition root's first action.
 *
 * MUST be the FIRST import in this service's entry (`index.ts`).
 * Being first in source order, ESM evaluates this module (including
 * its body) before any sibling import, so `initCore` runs before any
 * library code reads `env.*`.
 *
 * This is the application layer owning the `process.env` read: it
 * loads the developer's `.env` in dev (container-injected vars in
 * docker/prod), then hands the raw environment to `initCore`, which
 * validates it against the Zod schema and stores the result for the
 * `@breatic/core` `env` Proxy / `getConfig()` / `getRawEnvVar()`
 * accessors. `@breatic/core` itself never touches `process.env`
 * (CLAUDE.md "core / shared 不读环境变量" mandate).
 *
 * `process.env` carries the host `PATH` / `HOME` too, which the
 * agent script sandbox forwards via `getRawEnvVar` — no separate
 * injection step is needed.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { initCore, MONOREPO_ROOT } from "@breatic/core";

// Load the root .env in dev; a no-op when absent (docker / prod
// inject env vars directly into the container).
loadDotenv({ path: resolve(MONOREPO_ROOT, ".env") });

try {
  initCore(process.env);
} catch (err) {
  // Config validation failed (missing / malformed env). The
  // env-dependent logger can't be built either, so write to stderr
  // and fail fast — this is the application entry, where `console`
  // is permitted (it is banned only in library code). Exiting here
  // is the correct "refuse to start on bad config" behaviour.
  // eslint-disable-next-line no-console
  console.error(
    "FATAL: invalid configuration at startup —",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
