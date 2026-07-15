// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tests for {@link parseConfig}'s yjs-DB separation invariant: outside
 * dev, `YJS_DATABASE_URL` must point at a DIFFERENT database than
 * `DATABASE_URL` — a same-database misconfig would silently collapse
 * the two-DB split (and corrupt the shared migration ledger), so it
 * must fail fast at init.
 */

import { describe, it, expect } from "vitest";
import { parseConfig } from "@core/config/schema.js";

/**
 * Minimal valid raw env for {@link parseConfig}, overridable per case.
 * @param over - Fields to override on the base env map
 * @returns A raw env map with the required keys populated
 */
function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    SESSION_SECRET_KEY: "test-secret",
    DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
    YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic_yjs",
    ...over,
  };
}

describe("parseConfig — yjs DB separation", () => {
  it("rejects YJS_DATABASE_URL == DATABASE_URL (same database) outside dev", () => {
    expect(() =>
      parseConfig(
        baseEnv({
          ENV: "prod",
          YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
        }),
      ),
    ).toThrow(/different database/i);
  });

  it("accepts a distinct yjs database outside dev", () => {
    const cfg = parseConfig(baseEnv({ ENV: "prod" }));
    expect(cfg.YJS_DATABASE_URL).toContain("breatic_yjs");
  });

  it("allows the same instance in dev (second db name)", () => {
    expect(() => parseConfig(baseEnv({ ENV: "dev" }))).not.toThrow();
  });

  it("defaults YJS_DATABASE_URL when unset", () => {
    const env = baseEnv();
    delete env["YJS_DATABASE_URL"];
    const cfg = parseConfig(env);
    expect(cfg.YJS_DATABASE_URL).toMatch(/breatic_yjs$/);
  });
});
