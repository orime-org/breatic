// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 A2 — the voice catalog endpoint, at the route layer.
 *
 * The voices are read from the model's own yaml entry (#2156), behind a
 * session. What this file pins is the route's part: the session, the query
 * it passes on, and the status it carries out — the catalog is a double here,
 * shaped like the real one, which answers synchronously.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { catalog } = vi.hoisted(() => ({
  catalog: { listVoices: vi.fn(), getVoice: vi.fn() },
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, listVoices: catalog.listVoices, getVoice: catalog.getVoice };
});

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
    // A lazy singleton resolving against the validated config, which no unit
    // test stands up.
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  catalog.listVoices.mockReset().mockReturnValue(PAGE);
  catalog.getVoice.mockReset().mockReturnValue({ id: "v1", name: "Rachel" });
});

describe("GET /models/:name/voices (#1960 A2)", () => {
  it("turns a signed-out caller away", async () => {
    authed.current = false;
    const res = await call("/elevenlabs-v3/voices");
    expect(res.status).toBe(401);
    expect(catalog.listVoices).not.toHaveBeenCalled();
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
    catalog.listVoices.mockImplementationOnce(() => {
      throw new AppError(503, "unconfigured");
    });
    expect((await call("/elevenlabs-v3/voices")).status).toBe(503);
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
    catalog.getVoice.mockReturnValueOnce(null);
    expect((await call("/elevenlabs-v3/voices/gone")).status).toBe(404);
  });

  it("turns a signed-out caller away here too", async () => {
    authed.current = false;
    expect((await call("/elevenlabs-v3/voices/v1")).status).toBe(401);
    expect(catalog.getVoice).not.toHaveBeenCalled();
  });
});
