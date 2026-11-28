// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * collab connects to the product database only with its own account
 * (inner#2043): the configuration it hands core takes `DATABASE_URL` from
 * `COLLAB_DATABASE_URL`, and collab refuses to start without one.
 */

import { describe, expect, it } from "vitest";

import { collabCoreEnv, collabPostgresHint } from "@collab/collab-core-env.js";

const ADMIN = "postgres://breatic:admin-pw@localhost:5432/breatic";
const COLLAB = "postgres://breatic_collab:collab-pw@localhost:5432/breatic";

describe("collabCoreEnv", () => {
  it("hands core the collab account as DATABASE_URL", () => {
    const out = collabCoreEnv({ DATABASE_URL: ADMIN, COLLAB_DATABASE_URL: COLLAB, ENV: "dev" });
    expect(out.DATABASE_URL).toBe(COLLAB);
    expect(out.ENV).toBe("dev");
  });

  it("uses the collab account even when no admin URL is set", () => {
    expect(collabCoreEnv({ COLLAB_DATABASE_URL: COLLAB }).DATABASE_URL).toBe(COLLAB);
  });

  it("refuses to start without COLLAB_DATABASE_URL", () => {
    expect(() => collabCoreEnv({ DATABASE_URL: ADMIN })).toThrow("COLLAB_DATABASE_URL");
  });

  it("refuses an empty COLLAB_DATABASE_URL", () => {
    expect(() => collabCoreEnv({ DATABASE_URL: ADMIN, COLLAB_DATABASE_URL: "" })).toThrow("COLLAB_DATABASE_URL");
  });

  it("leaves the caller's environment unchanged", () => {
    const raw = { DATABASE_URL: ADMIN, COLLAB_DATABASE_URL: COLLAB };
    collabCoreEnv(raw);
    expect(raw.DATABASE_URL).toBe(ADMIN);
  });
});

describe("collabPostgresHint", () => {
  it("points at COLLAB_DATABASE_URL and the migration command that makes the login, without the password", () => {
    const hint = collabPostgresHint(COLLAB);
    expect(hint).toContain("COLLAB_DATABASE_URL=postgres://breatic_collab:***@localhost:5432/breatic");
    expect(hint).toContain("pnpm db:migrate");
    expect(hint).not.toContain("collab-pw");
    expect(hint).not.toMatch(/\bDATABASE_URL=/u);
  });
});
