// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as Fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { call, useInternalApp } from "./internal-api-harness.js";

const release = vi.hoisted(() => ({ releaseVersion: "1.2.3", revision: "1".repeat(40) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    readFile: (path: Parameters<typeof actual.readFile>[0], options: Parameters<typeof actual.readFile>[1]) =>
      typeof path === "string" && path.endsWith("/build-info.json")
        ? Promise.resolve(JSON.stringify(release))
        : actual.readFile(path, options),
  };
});

describe("internal deployment identity", () => {
  const running = useInternalApp("deployment-version");
  const path = "/internal/v1/deployment-version";

  it("returns the packaged identity and live business ledger after an authenticated read", async () => {
    const [ledger] = await running.sql<{ count: number; watermark: string }[]>`
      SELECT count(*)::int AS count, max(created_at)::text AS watermark
      FROM drizzle.__drizzle_migrations
    `;
    expect(ledger?.count).toBeGreaterThan(0);

    const response = await call(running.baseUrl, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.json).toMatchObject({
      ...release,
      actualBusinessMigration: { count: ledger?.count, watermark: Number(ledger?.watermark) },
      expectedBusinessMigration: { count: ledger?.count, watermark: Number(ledger?.watermark) },
    });
  });

  it("refuses anonymous requests", async () => {
    const anonymous = await call(running.baseUrl, path, { unsigned: true });
    expect(anonymous.status).toBe(401);
  });

  it("does not mount the deployment endpoint on the public app", async () => {
    const { createApp } = await import("@server/app.js");
    const publicApp = createApp();
    expect((await publicApp.request(path)).status).toBe(404);
    expect((await publicApp.request(`/api/v1${path}`)).status).toBe(404);
  });
});
