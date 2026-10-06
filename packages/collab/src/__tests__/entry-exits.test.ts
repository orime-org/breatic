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

describe("collab entry exits", () => {
  it("starts error monitoring right after config bootstrap", () => {
    const bootstrap = code.indexOf('import "@collab/bootstrap-config.js"');
    const init = code.indexOf("initSentry();");
    const firstLog = code.indexOf('initLogger("collab")');
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(init).toBeGreaterThan(bootstrap);
    expect(init).toBeLessThan(firstLog);
  });

  it("never ends the process without sending pending error events", () => {
    expect(code).not.toMatch(/process\.exit\(/);
  });

  it("waits for every exit, or chains it after the log flush in a callback", () => {
    const calls = [...code.matchAll(/(\S+)\s+exitProcess\(/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const prefix of calls) expect(["await", "void", "=>"]).toContain(prefix);
  });

  it("flushes its own log before every failure exit", () => {
    const exits = [...code.matchAll(/exitProcess\(1\)/g)].map((m) => m.index);
    for (const at of exits) {
      const before = code.slice(Math.max(0, at - 120), at);
      expect(before).toMatch(/flushLogger\(\)/);
    }
  });
});
