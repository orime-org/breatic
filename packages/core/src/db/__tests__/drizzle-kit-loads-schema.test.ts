// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * drizzle-kit loads the schema the CommonJS way, so `db:studio` and every
 * other drizzle-kit command only work while everything schema.ts imports at
 * runtime resolves under `require`. `@breatic/shared` is the import that has
 * broken this twice (inner#1561).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CORE_ROOT = resolve(import.meta.dirname, "../../..");

describe("drizzle-kit", () => {
  it("loads the business schema", () => {
    const run = spawnSync(
      resolve(CORE_ROOT, "node_modules/.bin/drizzle-kit"),
      ["export", "--dialect", "postgresql", "--schema", "./src/db/schema.ts"],
      { cwd: CORE_ROOT, encoding: "utf8", timeout: 60_000 },
    );
    expect(run.stderr).not.toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('CREATE TABLE "projects"');
  });
});
