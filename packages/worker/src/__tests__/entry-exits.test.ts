// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf-8");
const code = entry
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
  .join("\n");

describe("worker entry exits", () => {
  it("starts error monitoring right after config bootstrap", () => {
    const bootstrap = code.indexOf('import "@worker/bootstrap-config.js"');
    const init = code.indexOf("initSentry();");
    const firstLog = code.indexOf('initLogger("worker")');
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(init).toBeGreaterThan(bootstrap);
    expect(init).toBeLessThan(firstLog);
  });

  it("logs a SENTRY_DSN that is not a DSN once the logger is up", () => {
    const firstLog = code.indexOf('initLogger("worker")');
    const complaint = code.indexOf('"sentry_dsn_invalid"');
    expect(complaint).toBeGreaterThan(firstLog);
    expect(code).toMatch(/const monitoring = initSentry\(\);/);
    expect(code).toMatch(/if \(monitoring === "invalid_dsn"\) logger\.error\(\{\}, "sentry_dsn_invalid"\);/);
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

describe("worker task failure log", () => {
  it("logs the error itself, so the event keeps its stack", () => {
    const at = code.indexOf('"job_failed"');
    const block = code.slice(code.lastIndexOf("logger.error(", at), at);
    expect(block).toMatch(/\berr,/);
    expect(block).not.toMatch(/err\.message/);
  });
});

describe("consent receipt clean-up", () => {
  /**
   * How deep inside startWorker's body a position sits: 1 is its own block.
   * @param at - A position in the code.
   * @returns The block depth.
   */
  const depthInStartWorker = (at: number): number => {
    const body = code.slice(code.indexOf("export function startWorker"), at);
    return body.split("{").length - body.split("}").length;
  };

  it("runs its worker and schedules the daily job on every deployment, outside any vendor check", () => {
    for (const call of ["createWorker(ANALYTICS_CONSENT_QUEUE", "scheduleConsentPrune()"]) {
      const at = code.indexOf(call);
      expect(at, call).toBeGreaterThan(code.indexOf("export function startWorker"));
      expect(depthInStartWorker(at), call).toBe(1);
    }
  });
});
