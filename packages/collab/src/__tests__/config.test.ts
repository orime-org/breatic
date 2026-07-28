// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for `getCollabConfig`.
 *
 * This loader is behaviour knobs only. The WebSocket port used to live in
 * `config/collab.yaml` as a plain key with a schema default — no env var read
 * it, which made it the one service port unsettable from `.env` while the
 * other three already sat in the core env schema. It moved there too (#1831),
 * and what these tests guard is that it STAYS moved: a `port:` reappearing in
 * the YAML would silently be ignored (the schema strips unknown keys), leaving
 * whoever set it convinced they configured something.
 *
 * The YAML is read for real — stubbing the loader would make these vacuous.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";

async function loadConfig() {
  vi.resetModules();
  const mod = await import("../config.js");
  return mod.getCollabConfig();
}

describe("getCollabConfig", () => {
  it("loads the behaviour knobs from the YAML", async () => {
    const cfg = await loadConfig();

    expect(cfg.debounce).toBeGreaterThan(0);
    expect(cfg.max_debounce).toBeGreaterThanOrEqual(cfg.debounce);
    expect(cfg.max_connections_per_document).toBeGreaterThanOrEqual(0);
    expect(cfg.handling_lease.default_budget_ms).toBeGreaterThan(0);
    expect(typeof cfg.quiet).toBe("boolean");
    expect(typeof cfg.unload_immediately).toBe("boolean");
  });

  // The port belongs to the core env schema now. Someone putting `port:` back
  // into collab.yaml gets a silent no-op: zod's default unknown-key stripping
  // drops it and the service keeps listening on COLLAB_PORT, while whoever
  // edited the YAML believes they configured something.
  //
  // Assert on the YAML TEXT, not on the parsed object. Asserting the parsed
  // config has no `port` property is vacuous — stripping guarantees it whether
  // or not the key is in the file. (Verified: adding `port: 9999` to the YAML
  // left that assertion green.)
  it("collab.yaml declares no port — that setting lives in the core env schema", () => {
    const yaml = readFileSync(
      resolve(import.meta.dirname, "../../../../config/collab.yaml"),
      "utf-8",
    );

    expect(yaml).not.toMatch(/^\s*port\s*:/m);
  });

  it("returns the same frozen object on repeat calls", async () => {
    vi.resetModules();
    const mod = await import("../config.js");

    const first = mod.getCollabConfig();
    const second = mod.getCollabConfig();

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
