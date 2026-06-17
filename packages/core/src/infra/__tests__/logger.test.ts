// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Core logger tests — proves the main-thread `pino.multistream` design
 * (no worker-thread transport) so the drain-wait stall class that
 * silently killed collab logging (2026-06-01 → 06-16, and again at the
 * 2026-06-17 15:50:42 freeze) cannot recur.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServiceLogger,
  createLogger,
  initLogger,
} from "@core/infra/logger.js";

/**
 * Read everything written under `<logsRoot>/<service>/`.
 * @param logsRoot - The injected logs root directory.
 * @param service - The service name (= subdirectory).
 * @returns Concatenated content of every file in the service log dir.
 */
function readServiceLog(logsRoot: string, service: string): string {
  const dir = join(logsRoot, service);
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("");
}

describe("core logger — main-thread multistream, no worker", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  /**
   * Make a throwaway logs root that is cleaned up after each test.
   * @returns Absolute path to a fresh temp directory.
   */
  function tmpRoot(): string {
    const d = mkdtempSync(join(tmpdir(), "logger-test-"));
    created.push(d);
    return d;
  }

  it("writes lines to logs/<service>/ tagged with the service name", () => {
    const root = tmpRoot();
    const log = buildServiceLogger("svc-a", {
      logsRoot: root,
      debug: true,
      console: "none",
    });
    log.info({ hello: "world" }, "hi");
    const content = readServiceLog(root, "svc-a");
    expect(content).toContain('"name":"svc-a"');
    expect(content).toContain('"msg":"hi"');
    expect(content).toContain('"hello":"world"');
  });

  it("child loggers carry a component tag (createLogger contract)", () => {
    const root = tmpRoot();
    const log = buildServiceLogger("svc-b", {
      logsRoot: root,
      debug: true,
      console: "none",
    });
    log.child({ component: "auth" }).warn({ reason: "not_member" }, "auth_rejected");
    const content = readServiceLog(root, "svc-b");
    expect(content).toContain('"component":"auth"');
    expect(content).toContain('"reason":"not_member"');
  });

  it("flushes synchronously — the line is in the file immediately, no worker round-trip", () => {
    const root = tmpRoot();
    const log = buildServiceLogger("svc-c", {
      logsRoot: root,
      debug: true,
      console: "none",
    });
    log.info("sync-line");
    // No await, no flush call. A main-thread sync destination has already
    // written; a worker-thread transport would not have flushed yet.
    expect(readServiceLog(root, "svc-c")).toContain('"msg":"sync-line"');
  });

  it("does not deadlock or drop under a log flood (root-cause regression)", () => {
    const root = tmpRoot();
    const log = buildServiceLogger("svc-d", {
      logsRoot: root,
      debug: true,
      console: "none",
    });
    for (let i = 0; i < 2000; i++) log.info({ i }, "flood");
    const lines = readServiceLog(root, "svc-d")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(2000);
  });

  it("createLogger() delegates to the active logger and tags the component", () => {
    const root = tmpRoot();
    initLogger("svc-e", { logsRoot: root, debug: true, console: "none" });
    createLogger("members-sync").info("started");
    expect(readServiceLog(root, "svc-e")).toContain('"component":"members-sync"');
  });

  it("a createLogger bound BEFORE initLogger still honors the later initLogger (ESM import-order safe)", () => {
    const root = tmpRoot();
    // Mirrors the real entry: service modules run `const log = createLogger(...)`
    // at module top-level (import phase), which executes BEFORE the entry's
    // `initLogger(...)` statement. The child must bind to the service logger,
    // not the lazy "api" default — otherwise every collab line is mis-tagged
    // `name:"api"` (the 2026-06-17 unification regression this guards).
    const early = createLogger("early-bird");
    initLogger("svc-f", { logsRoot: root, debug: true, console: "none" });
    early.info("after-init");
    const content = readServiceLog(root, "svc-f");
    expect(content).toContain('"name":"svc-f"');
    expect(content).toContain('"component":"early-bird"');
  });
});
