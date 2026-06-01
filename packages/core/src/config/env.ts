/**
 * Backward-compatible config entry point.
 *
 * Historically this module read `process.env` + loaded `.env` at
 * import time and validated via `@t3-oss/env-core`. That made
 * `@breatic/core` read environment variables - a library making an
 * application decision, violating the same principle that bans
 * `logger.*` / `process.exit()` in library code (CLAUDE.md "core/shared must not read env vars" mandate, 2026-05-30).
 *
 * The read now lives in the application layer: each service entry
 * (server / worker / collab) reads `process.env` once at startup and
 * injects it via `initCore(process.env)` (see `@core/config/runtime`).
 * This module is kept as a thin re-export so the ~33 existing
 * `import { env } from "@core/config/env.js"` call sites stay
 * unchanged - `env` is now the runtime Proxy backed by the injected,
 * validated config.
 */

export { env, MONOREPO_ROOT } from "@core/config/runtime.js";
