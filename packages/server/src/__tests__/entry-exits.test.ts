// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf-8");
const code = entry
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
  .join("\n");

describe("server entry exits", () => {
  it("starts error monitoring right after config bootstrap", () => {
    const bootstrap = code.indexOf('import "@server/bootstrap-config.js"');
    const init = code.indexOf("initSentry();");
    const firstLog = code.indexOf('initLogger("server")');
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(init).toBeGreaterThan(bootstrap);
    expect(init).toBeLessThan(firstLog);
  });

  it("logs a SENTRY_DSN that is not a DSN once the logger is up", () => {
    const firstLog = code.indexOf('initLogger("server")');
    const complaint = code.indexOf('"sentry_dsn_invalid"');
    expect(complaint).toBeGreaterThan(firstLog);
    expect(code).toMatch(/const monitoring = initSentry\(\);/);
    expect(code).toMatch(/if \(monitoring === "invalid_dsn"\) logger\.error\(\{\}, "sentry_dsn_invalid"\);/);
  });

  it("builds the provider after the agent config it reads and before the model catalog, whose entries ask it", () => {
    const agent = code.indexOf("getAgentConfig();");
    const built = code.indexOf("initProvider();");
    const catalog = code.indexOf("modelCatalog.getModelCatalog();");
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(built).toBeGreaterThan(agent);
    expect(catalog).toBeGreaterThan(built);
  });

  it("never ends the process without sending pending error events", () => {
    expect(code).not.toMatch(/process\.exit\(/);
  });

  it("waits for every exit, or marks the callback exits that have nothing after them", () => {
    const calls = [...code.matchAll(/(\S+)\s+exitProcess\(/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const prefix of calls) expect(["await", "void"]).toContain(prefix);
  });
});

describe("server Timeline configuration check (#1502 design §2)", () => {
  it("reads the Timeline configuration before it serves, and logs and exits when it cannot", () => {
    const check = code.indexOf("getTimelineConfig();");
    const failed = code.indexOf('"timeline_config_invalid"');
    const serving = code.indexOf("const server = serve(");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(check);
    expect(serving).toBeGreaterThan(failed);
    expect(code.slice(check, failed)).toMatch(/catch \(err\)[\s\S]*logger\.(error|fatal)\(\{ err\b[^}]*\}, $/);
    expect(code.slice(failed, failed + 80)).toMatch(/await exitProcess\(1\)/);
  });
});
