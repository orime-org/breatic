// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The internal listener counts two callers apart (inner#1955): the back
 * office, a person at a screen, and the other regions, whose every credit
 * admission, settlement and outbox event arrives here. Each has its own
 * budget in `config/rate-limits.yaml`.
 */

import { describe, expect, it, vi } from "vitest";

const counted = vi.hoisted(() => [] as string[]);
vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: (action: string) => async (c: unknown, next: () => Promise<void>) => {
    counted.push(`${action} ${(c as { req: { path: string } }).req.path}`);
    await next();
  },
}));

const { initCore } = await import("@breatic/core");
initCore({
  DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
  YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic_yjs",
});
const { createInternalApp } = await import("@server/internal-app.js");

describe("the internal listener's rate limits", () => {
  it("counts calls between regions under their own budget and the back office under its own", async () => {
    const app = createInternalApp();

    await app.request("/internal/global/getProfiles", { method: "POST" });
    await app.request("/internal/region/probe", { method: "POST" });
    await app.request("/internal/v1/maintenance/queue");

    expect(counted).toEqual([
      "region-api /internal/global/getProfiles",
      "region-api /internal/region/probe",
      "internal-api /internal/v1/maintenance/queue",
    ]);
  });
});
