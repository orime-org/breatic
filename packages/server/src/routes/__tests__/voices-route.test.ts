// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 A2 — the voice catalog endpoint, at the route layer.
 *
 * The model catalog beside it is public and served from local yaml. This one
 * is not: every call reaches a vendor on our key and against our quota, so it
 * takes a session and a throttle, and repeats inside the cache window are
 * answered without going out again. Those three are the route's decisions,
 * which is what this file pins — the catalog itself is a double here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { catalog, rateLimitFor, cache } = vi.hoisted(() => ({
  catalog: { listVoices: vi.fn(), getVoice: vi.fn() },
  rateLimitFor: vi.fn(),
  cache: { get: vi.fn(), set: vi.fn() },
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, listVoices: catalog.listVoices, getVoice: catalog.getVoice };
});

vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: (...args: unknown[]) => {
    rateLimitFor(...args);
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
}));

const authed = { current: true };

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (
    c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => unknown },
    next: () => Promise<void>,
  ) => {
    if (!authed.current) return c.json({ error: { code: 401 } }, 401);
    c.set("user", { id: "u-1" });
    return next();
  },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Both are lazy singletons resolving against the validated config, which
    // no unit test stands up. MONOREPO_ROOT stays real so the limits loader
    // reads the actual config/limits.yaml, TTL and all.
    env: { ENV: "test" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getRedis: () => ({ get: cache.get, set: cache.set }),
  };
});

const { modelsRoute } = await import("@server/routes/models.js");
const { errorHandler } = await import("@server/middleware/error-handler.js");
const { Hono } = await import("hono");

// The app mounts this route behind the global error handler, which is what
// turns a thrown AppError into its own status. Calling the route bare would
// make every refusal a 500 and hide exactly what these cases are about.
const app = new Hono();
app.onError(errorHandler);
app.route("/", modelsRoute);

const PAGE = {
  voices: [{ id: "v1", name: "Rachel" }],
  hasMore: false,
};

/**
 * Call the route the way the app mounts it.
 * @param path - Path under the models route.
 * @returns The response.
 */
async function call(path: string): Promise<Response> {
  return app.request(path);
}

beforeEach(() => {
  authed.current = true;
  catalog.listVoices.mockReset().mockResolvedValue(PAGE);
  catalog.getVoice.mockReset().mockResolvedValue({ id: "v1", name: "Rachel" });
  cache.get.mockReset().mockResolvedValue(null);
  cache.set.mockReset().mockResolvedValue("OK");
});

describe("GET /models/:name/voices (#1960 A2)", () => {
  it("turns a signed-out caller away", async () => {
    authed.current = false;
    const res = await call("/elevenlabs-v3/voices");
    expect(res.status).toBe(401);
    expect(catalog.listVoices).not.toHaveBeenCalled();
  });

  it("throttles per user, since each call spends our vendor quota", () => {
    // Registered once, when the route is built.
    expect(rateLimitFor).toHaveBeenCalledWith("voices", "user");
  });

  it("answers with the page the catalog built", async () => {
    const res = await call("/elevenlabs-v3/voices");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: PAGE });
  });

  it("passes the caller's search term and cursor through", async () => {
    await call("/elevenlabs-v3/voices?query=narrator&cursor=tok-2");
    expect(catalog.listVoices).toHaveBeenCalledWith("elevenlabs-v3", {
      query: "narrator",
      cursor: "tok-2",
    });
  });

  it("carries the catalog's own status out, rather than a blanket 500", async () => {
    const { AppError } = await import("@breatic/core");
    catalog.listVoices.mockRejectedValueOnce(new AppError(503, "unconfigured"));
    expect((await call("/elevenlabs-v3/voices")).status).toBe(503);
  });
});

describe("the cache in front of it", () => {
  it("answers a repeat within the window without calling out again", async () => {
    cache.get.mockResolvedValueOnce(JSON.stringify(PAGE));
    const res = await call("/elevenlabs-v3/voices");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: PAGE });
    expect(catalog.listVoices).not.toHaveBeenCalled();
  });

  it("stores every answer under a key that expires", async () => {
    await call("/elevenlabs-v3/voices");

    const [key, value, mode, ttl] = cache.set.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    // Prefixed by environment, the way every other key in this deployment is:
    // two deployments on one Redis must not read each other's answers.
    expect(key).toMatch(/^[^:]+:server:voices:/);
    expect(JSON.parse(value)).toEqual(PAGE);
    expect(mode).toBe("EX");
    expect(ttl).toBeGreaterThan(0);
  });

  it("keys on the search term, so one search does not answer another", async () => {
    await call("/elevenlabs-v3/voices?query=alpha");
    await call("/elevenlabs-v3/voices?query=beta");

    const [first] = cache.set.mock.calls[0] as [string];
    const [second] = cache.set.mock.calls[1] as [string];
    expect(first).not.toBe(second);
  });

  it("keys on the cursor too, so page two does not answer page one", async () => {
    await call("/elevenlabs-v3/voices");
    await call("/elevenlabs-v3/voices?cursor=tok-2");

    const [first] = cache.set.mock.calls[0] as [string];
    const [second] = cache.set.mock.calls[1] as [string];
    expect(first).not.toBe(second);
  });
});

describe("GET /models/:name/voices/:voiceId (#1960 §6.4)", () => {
  it("names the voice a node already stores", async () => {
    const res = await call("/elevenlabs-v3/voices/v1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: "v1", name: "Rachel" } });
    expect(catalog.getVoice).toHaveBeenCalledWith("elevenlabs-v3", "v1");
  });

  it("answers 404 for an id this provider no longer carries", async () => {
    catalog.getVoice.mockResolvedValueOnce(null);
    expect((await call("/elevenlabs-v3/voices/gone")).status).toBe(404);
  });

  it("turns a signed-out caller away here too", async () => {
    authed.current = false;
    expect((await call("/elevenlabs-v3/voices/v1")).status).toBe(401);
    expect(catalog.getVoice).not.toHaveBeenCalled();
  });
});
