/**
 * Health endpoint test.
 *
 * Uses Hono's built-in test client — no real HTTP server needed.
 * Mocks @breatic/core for db and redis so no real connections are needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock AI SDK to avoid OpenTelemetry dep issues
vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// Mock @breatic/core — provide fake db + redis so health check passes
vi.mock("@breatic/core", async (importOriginal) => {
  const mockRedis = {
    ping: () => Promise.resolve("PONG"),
    on: () => mockRedis,
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    rawPg: Object.assign(
      (strings: TemplateStringsArray) => {
        if (strings[0]?.includes("SELECT 1")) return Promise.resolve([{ ok: 1 }]);
        return Promise.resolve([]);
      },
      { end: () => Promise.resolve() },
    ),
    db: {},
    closeDb: () => Promise.resolve(),
    getRedis: () => mockRedis,
    closeRedis: () => Promise.resolve(),
    env: { ENV: "dev", PORT: 3000, ALLOWED_ORIGINS: "http://localhost:3001", STORAGE_PROVIDER: "local" },
    MONOREPO_ROOT: "/tmp",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
    runMigrations: vi.fn(),
    createQueue: () => ({ add: vi.fn() }),
    closeQueues: vi.fn(),
  };
});

import { createApp } from "../app.js";

describe("GET /api/health", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it("should return 200 with ok status when services are healthy", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.services.db).toBe("ok");
    expect(body.services.redis).toBe("ok");
    expect(body.timestamp).toBeTruthy();
  });
});
