// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Application logger (pino) — shared by every backend service
 * (server / worker / collab).
 *
 * Call {@link initLogger} at the entry point before any logging:
 *   - server: initLogger("server")
 *   - worker: initLogger("worker")
 *   - collab: initLogger("collab")
 *
 * Log files: `logs/{service}/{service}.{yyyy-MM-dd}.log`.
 * Console: pretty-printed in dev, JSON in production.
 *
 * Transport model: **main-thread `pino.multistream`, never a worker
 * thread**. pino's `transport: { targets }` option runs writers in a
 * worker thread (thread-stream); that worker can drain-wait stall —
 * park on a `drain` that never fires, stop reading the ring buffer, and
 * die with the fd open, zero writes, and NO `error` event (so an
 * `error` listener cannot catch it). collab lost file logging this way
 * (2026-06-01 → 06-16) and froze again at 2026-06-17 15:50:42. A
 * main-thread multistream has no worker, no cross-thread drain wait, and
 * `pino.destination({ sync: true })` flushes inline — the stall class is
 * structurally impossible. See pino #1662 / #1429 / #1338 / #1889.
 */

import pino from "pino";
import pretty from "pino-pretty";
import { resolve } from "node:path";
import { env, MONOREPO_ROOT } from "@core/config/env.js";

/** Where a logger writes and how loud it is — injected so tests can redirect. */
export interface LoggerOptions {
  /** Root directory under which `<service>/` log dirs are created. */
  logsRoot: string;
  /** When true, level is `debug`; otherwise `info`. */
  debug: boolean;
  /** Console sink: pretty (dev), JSON to stdout (prod), or none (tests). */
  console: "pretty" | "json" | "none";
}

/**
 * Build the default options from the injected core config. Evaluated at
 * call time (not module load) so importing this module reads no `env.*`
 * before `initCore` — the same lazy-singleton rule as db / Redis.
 * @returns Options pointing at the monorepo `logs/` root, console mode by ENV.
 */
function defaultOptions(): LoggerOptions {
  return {
    logsRoot: resolve(MONOREPO_ROOT, "logs"),
    debug: env.DEBUG,
    console: env.ENV === "dev" ? "pretty" : "json",
  };
}

/**
 * Today's date as `yyyy-MM-dd`, used in the log file name. Computed once
 * per logger build (a long-running process keeps its start-date file; in
 * production, rotation is delegated to the container log driver /
 * logrotate rather than an in-process worker).
 * @returns The current UTC date as `yyyy-MM-dd`.
 */
function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build a pino logger that fans out to a per-service file plus an
 * optional console, all on the **main thread** via `pino.multistream`.
 * @param serviceName - Tag used for the `name` field, log dir, and file name.
 * @param opts - Injected sink configuration ({@link LoggerOptions}).
 * @returns The configured pino logger.
 */
export function buildServiceLogger(
  serviceName: string,
  opts: LoggerOptions,
): pino.Logger {
  const level = opts.debug ? "debug" : "info";
  const streams: pino.StreamEntry[] = [];

  // File sink: main-thread sync destination (SonicBoom). `mkdir` creates
  // the `<logsRoot>/<service>/` dir. Wrapped so a read-only filesystem
  // degrades to console-only instead of crashing the entry.
  try {
    const file = resolve(
      opts.logsRoot,
      serviceName,
      `${serviceName}.${currentDate()}.log`,
    );
    streams.push({
      level,
      stream: pino.destination({ dest: file, sync: true, mkdir: true }),
    });
  } catch {
    // Read-only environment — fall through to console-only below.
  }

  if (opts.console === "pretty") {
    streams.push({ level, stream: pretty({ colorize: true }) as pino.DestinationStream });
  } else if (opts.console === "json") {
    streams.push({ level, stream: pino.destination({ dest: 1, sync: true }) });
  }

  // Never produce a logger with zero sinks (read-only fs + console:"none").
  if (streams.length === 0) {
    streams.push({ level, stream: pino.destination({ dest: 1, sync: true }) });
  }

  return pino(
    {
      name: serviceName,
      level,
      timestamp: () =>
        `,"timestamp":"${new Date().toISOString()}","time":${Date.now()}`,
    },
    pino.multistream(streams),
  );
}

/**
 * Bumped on every {@link initLogger} call so {@link createLogger} children
 * built before (or across) an init are rebuilt against the active logger.
 */
let _generation = 0;

/**
 * Initialize the process-wide logger for a specific service. Must be
 * called once at the entry point before any logging.
 * @param serviceName - The service tag (e.g. `"server"`) used for log routing.
 * @param opts - Sink configuration; defaults to the injected core config.
 */
export function initLogger(
  serviceName: string,
  opts: LoggerOptions = defaultOptions(),
): void {
  logger = buildServiceLogger(serviceName, opts);
  _generation += 1;
}

/**
 * Lazily-built default `"api"` logger, returned by the {@link logger}
 * Proxy until {@link initLogger} replaces it. Building it reads `env.*`,
 * so it must be deferred past `initCore` — the same reason db / Redis /
 * LLM providers are lazy.
 */
let _defaultLogger: pino.Logger | null = null;

/**
 * Build (once) and return the lazily-initialised default logger.
 * @returns The process-wide default pino logger.
 */
function getDefaultLogger(): pino.Logger {
  if (_defaultLogger === null) {
    _defaultLogger = buildServiceLogger("api", defaultOptions());
  }
  return _defaultLogger;
}

/**
 * Create a child logger bound to a component name — the per-module
 * sub-logger every service uses (`createLogger("auth")` etc.). The
 * `component` field lands on every line so a single grep finds one
 * module's output.
 * @param component - Component name attached as the `component` field.
 * @returns A pino child logger of the active process logger.
 */
export function createLogger(component: string): pino.Logger {
  // Lazy + generation-aware. Service modules run `createLogger(...)` at module
  // top-level (import phase), which executes BEFORE the entry's `initLogger()`.
  // Building the child eagerly would bind it to the lazy "api" default and
  // mis-tag every line `name:"api"`. Instead build on first access (initLogger
  // has run by then) and rebuild if a later initLogger swapped the logger.
  let child: pino.Logger | null = null;
  let childGeneration = -1;
  return new Proxy({} as pino.Logger, {
    get(_target, prop) {
      if (child === null || childGeneration !== _generation) {
        child = logger.child({ component });
        childGeneration = _generation;
      }
      const real = child as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(real)
        : value;
    },
  });
}

/**
 * Logger instance — defaults to `"api"`, call {@link initLogger} to override.
 *
 * The initial value is a Proxy over the lazily-built default logger so
 * that importing this module (and therefore the `@breatic/core` barrel)
 * reads no env at eval time — config is injected via `initCore` at
 * startup, before the app entry calls `initLogger` or logs anything.
 * Once `initLogger` runs, this binding is reassigned to a concrete logger.
 */
// eslint-disable-next-line import/no-mutable-exports
export let logger: pino.Logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    const real = getDefaultLogger() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
});
