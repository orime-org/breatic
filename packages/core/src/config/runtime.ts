/**
 * Core runtime configuration holder + injection boundary.
 *
 * `@breatic/core` does NOT read `process.env` (CLAUDE.md "core/shared must not read env vars" mandate). Instead, each application entry
 * (server / worker / collab = the composition root) reads
 * `process.env` once at startup and injects it via {@link initCore}.
 * Library code then reads the validated config through:
 *
 *   - {@link env} - a Proxy so existing `env.DATABASE_URL` call sites
 *     keep working unchanged (they resolve against the injected,
 *     validated config at access time);
 *   - {@link getConfig} - the explicit typed accessor;
 *   - {@link getRawEnvVar} - for dynamic lookups that aren't part of
 *     the typed schema (a Skill's declared required env var, the
 *     host `PATH` / `HOME` forwarded to the agent script sandbox).
 *
 * Accessing config before {@link initCore} runs throws a clear error
 * rather than silently using `undefined` - the composition root must
 * initialize before any library code runs (it does: `initCore` is
 * the first statement in each entry's `main()`).
 */

import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parseConfig, type CoreConfig } from "@core/config/schema.js";

/**
 * Find the monorepo root by walking up from this file until
 * `pnpm-workspace.yaml` is found. Works from both source
 * (`packages/core/src/config/`) and compiled (`packages/core/dist/`).
 * Reads the filesystem + `process.cwd()` - NOT `process.env` - so it
 * stays within the "no env reads" mandate (cwd is not configuration).
 * @returns the absolute path to the monorepo root, falling back to
 *   `process.cwd()` when the workspace marker is not found
 */
function findMonorepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: process.cwd() (works in Docker where cwd = /app).
  return process.cwd();
}

/** Absolute path to the monorepo root (filesystem-derived). */
export const MONOREPO_ROOT = findMonorepoRoot();

/** Injected, validated config - null until {@link initCore} runs. */
let _config: CoreConfig | null = null;

/**
 * The raw env map the application injected - kept for dynamic lookups
 * (Skill required-env checks, host PATH/HOME forwarding) that aren't
 * part of the typed schema. Null until {@link initCore} runs.
 */
let _rawEnv: Record<string, string | undefined> | null = null;

/**
 * Initialize core with the application's raw environment map.
 *
 * Call this **once**, as the first statement of each service entry's
 * startup, before any other `@breatic/core` code runs. The raw map
 * is validated via {@link parseConfig}; on failure this throws (the
 * entry's top-level catch logs + exits).
 * @param rawEnv - The application's `process.env` (the entry owns the
 *   read; core only processes the map it is handed).
 * @returns The validated config (also retrievable via {@link getConfig}).
 */
export function initCore(rawEnv: Record<string, string | undefined>): CoreConfig {
  _rawEnv = rawEnv;
  _config = parseConfig(rawEnv);
  return _config;
}

/**
 * The validated core configuration.
 * @returns the validated config injected by {@link initCore}
 * @throws {Error} if accessed before {@link initCore} has run.
 */
export function getConfig(): CoreConfig {
  if (_config === null) {
    throw new Error(
      "@breatic/core config accessed before initCore() ran. The " +
      "application entry (server / worker / collab) must call " +
      "initCore() with the process environment as the first startup " +
      "statement. In tests, the vitest setup file does this.",
    );
  }
  return _config;
}

/**
 * Read a single raw environment variable by name - for dynamic
 * lookups that aren't in the typed schema (a Skill's declared
 * required env var, the host `PATH` / `HOME` forwarded to the agent
 * script sandbox). Returns `undefined` if not set or before
 * {@link initCore} runs (callers treat absence as "not configured").
 * @param name - The environment variable name.
 * @returns the raw value, or `undefined` if unset or before {@link initCore} ran
 */
export function getRawEnvVar(name: string): string | undefined {
  return _rawEnv?.[name];
}

/**
 * Backward-compatible config accessor as a Proxy.
 *
 * Existing call sites read `env.DATABASE_URL` etc.; the Proxy
 * resolves each property against the injected, validated config at
 * access time. This keeps the ~118 `env.X` consumer call sites
 * unchanged while moving the `process.env` read out of core.
 */
export const env: CoreConfig = new Proxy({} as CoreConfig, {
  get(_target, prop) {
    return getConfig()[prop as keyof CoreConfig];
  },
  has(_target, prop) {
    return prop in getConfig();
  },
  ownKeys() {
    return Reflect.ownKeys(getConfig());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(getConfig(), prop);
  },
});
