// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
const code = entry.split("\n")
  .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
  .join("\n");

describe("upgrade session shutdown wiring", () => {
  it("receives the admission stop function from createCollabServer", () => {
    const creation = code.indexOf("await createCollabServer(");
    expect(creation).toBeGreaterThanOrEqual(0);
    const binding = code.slice(code.lastIndexOf("const ", creation), creation);
    expect(binding).toMatch(/\bstopUpgradeSessions\b/);
  });

  it("stops raw session admissions synchronously before releasing the listener or awaiting consumers", () => {
    const shutdown = code.slice(code.indexOf("const shutdown = async"));
    const stop = shutdown.indexOf("stopUpgradeSessions();");
    const close = shutdown.indexOf("server.httpServer.close()");
    const consumers = shutdown.indexOf("await Promise.all([taskConsumer.stop(), lifecycleConsumer.stop()])");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(stop);
    expect(consumers).toBeGreaterThan(stop);
    expect(shutdown.slice(Math.max(0, stop - 6), stop)).not.toContain("await");
  });
});
