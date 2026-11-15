// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Tests for {@link createGlobalApi}: the region that holds the global data
 * calls the global functions in process, and every other region reaches them
 * with a signed request to the global region's internal listener.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
const testEnv = vi.hoisted(() => ({
  REGION: "us-west",
  GLOBAL_REGION: "us-west",
  INTERNAL_API_SECRET: "test-internal-secret",
  GLOBAL_API_URL: "http://10.0.0.5:3002",
  REGION_API_URLS: { sg: "http://10.0.0.9:3002/" },
}));
vi.mock("@core/config/env.js", () => ({ env: testEnv }));
vi.mock("@core/config/regions.js", () => ({ getRegionsConfig: () => ({ global_api_timeout_ms: 300 }) }));

import {
  GlobalApiError,
  callRegion,
  createGlobalApi,
  globalApiHealthChecks,
  isRegionUnavailable,
  lastGlobalCallSucceeded,
  UNREACHABLE_STATUS,
} from "@core/region/global-api.js";

const SECRET = vi.hoisted(() => "test-internal-secret");

/**
 * The global functions a test hands to the API.
 * @returns A spied local implementation.
 */
function localFunctions(): { readUserName: (userId: string) => Promise<string> } {
  return { readUserName: vi.fn(async (userId: string) => `local:${userId}`) };
}

/**
 * A fetch stand-in that answers every request with one JSON body.
 * @param status - The HTTP status to answer with.
 * @param body - The JSON body to answer with.
 * @returns The spied fetch.
 */
function answerWith(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  testEnv.REGION = "us-west";
});

describe("createGlobalApi", () => {
  it("calls the global function in process when this region holds the global data", async () => {
    const fetchMock = answerWith(200, { result: "remote" });
    const local = localFunctions();
    const api = createGlobalApi(local);

    await expect(api.readUserName("u1")).resolves.toBe("local:u1");
    expect(local.readUserName).toHaveBeenCalledWith("u1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the arguments to the global region and returns its result", async () => {
    const fetchMock = answerWith(200, { result: "remote:u1" });
    const local = localFunctions();
    testEnv.REGION = "sg";
    const api = createGlobalApi(local);

    await expect(api.readUserName("u1")).resolves.toBe("remote:u1");
    expect(local.readUserName).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.0.0.5:3002/internal/global/readUserName");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ args: ["u1"] });
  });

  it("signs the request the way the internal listener checks it", async () => {
    const fetchMock = answerWith(200, { result: "remote:u1" });
    testEnv.REGION = "sg";
    const api = createGlobalApi(localFunctions());

    await api.readUserName("u1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const admin = headers.get("x-internal-admin");
    const timestamp = headers.get("x-internal-timestamp");
    const nonce = headers.get("x-internal-nonce");
    expect(admin).toBe("region-sg");
    expect(timestamp).toMatch(/^[0-9]+$/);
    expect(Math.abs(Number(timestamp) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(5);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const canonical = [
      "POST",
      "/internal/global/readUserName",
      timestamp,
      nonce,
      admin,
      "",
      String(init.body),
    ].join("\n");
    const expected = `v1=${createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex")}`;
    expect(headers.get("x-internal-signature")).toBe(expected);
  });

  it("uses a fresh nonce for every request", async () => {
    const fetchMock = answerWith(200, { result: "remote" });
    testEnv.REGION = "sg";
    const api = createGlobalApi(localFunctions());

    await api.readUserName("u1");
    await api.readUserName("u1");
    const nonces = fetchMock.mock.calls.map(
      ([, init]) => new Headers((init as RequestInit).headers).get("x-internal-nonce"),
    );
    expect(new Set(nonces).size).toBe(2);
  });

  it("rejects with the code the global region answered when it refuses", async () => {
    answerWith(409, { code: "studio_creation_in_progress" });
    testEnv.REGION = "sg";
    const api = createGlobalApi(localFunctions());

    const failure = await api.readUserName("u1").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GlobalApiError);
    expect((failure as GlobalApiError).status).toBe(409);
    expect((failure as GlobalApiError).code).toBe("studio_creation_in_progress");
  });

  it("rejects when the global region cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    testEnv.REGION = "sg";
    const api = createGlobalApi(localFunctions());

    await expect(api.readUserName("u1")).rejects.toThrow();
  });

  it("treats a 200 whose body cannot be read as no answer, never as a null result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"result\":", { status: 200 })));
    testEnv.REGION = "sg";
    const api = createGlobalApi(localFunctions());

    const failure = await api.readUserName("u1").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GlobalApiError);
    expect((failure as GlobalApiError).status).toBe(UNREACHABLE_STATUS);
  });
});

describe("reading a remote answer", () => {
  it("gives up on a body that does not arrive within the wait, as no answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 })));
    testEnv.REGION = "sg";
    const api = createGlobalApi(localFunctions());

    const started = Date.now();
    const failure = await api.readUserName("u1").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GlobalApiError);
    expect((failure as GlobalApiError).status).toBe(UNREACHABLE_STATUS);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("isRegionUnavailable", () => {
  it.each([UNREACHABLE_STATUS, 401, 403, 408, 429, 500, 503])("counts %s as unavailable for now", (status) => {
    expect(isRegionUnavailable(new GlobalApiError(status, "x", "x"))).toBe(true);
  });

  it.each([400, 404, 409, 413, 422])("counts %s as the other side's own answer", (status) => {
    expect(isRegionUnavailable(new GlobalApiError(status, "x", "x"))).toBe(false);
  });

  it("does not judge errors that are not a cross-region call's", () => {
    expect(isRegionUnavailable(new Error("boom"))).toBe(false);
  });
});

describe("callRegion", () => {
  it("calls the named region at its configured address, signed as this region", async () => {
    const fetchMock = answerWith(200, { result: "ok" });

    expect(await callRegion("sg", "probe", [], 1000)).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://10.0.0.9:3002/internal/region/probe");
    expect(new Headers(init.headers).get("x-internal-admin")).toBe("region-us-west");
  });

  it("refuses a region with no address without sending anything", async () => {
    const fetchMock = answerWith(200, { result: "ok" });

    const failure = await callRegion("eu", "probe", [], 1000).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GlobalApiError);
    expect((failure as GlobalApiError).message).toBe("no address for region eu");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds no address under an object's inherited names", async () => {
    const fetchMock = answerWith(200, { result: "ok" });

    for (const region of ["__proto__", "constructor", "toString"]) {
      const failure = await callRegion(region, "probe", [], 1000).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(GlobalApiError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("lastGlobalCallSucceeded", () => {
  it("follows the outcome of the latest call to the global region", async () => {
    testEnv.REGION = "sg";
    const api = createGlobalApi(localFunctions());

    answerWith(200, { result: "remote" });
    await api.readUserName("u1");
    expect(lastGlobalCallSucceeded()).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await api.readUserName("u1").catch(() => undefined);
    expect(lastGlobalCallSucceeded()).toBe(false);

    answerWith(409, { code: "refused" });
    await api.readUserName("u1").catch(() => undefined);
    expect(lastGlobalCallSucceeded()).toBe(true);

    answerWith(401, { code: "invalid_signature" });
    await api.readUserName("u1").catch(() => undefined);
    expect(lastGlobalCallSucceeded()).toBe(false);
  });
});

describe("globalApiHealthChecks", () => {
  it("adds no check in the region that holds the global data", () => {
    expect(globalApiHealthChecks()).toEqual([]);
  });

  it("adds one informational check elsewhere, following the latest global call", async () => {
    testEnv.REGION = "sg";
    try {
      const [check] = globalApiHealthChecks();
      expect(check).toMatchObject({ name: "global_api", informational: true });
      expect(await check!.check()).toBe(lastGlobalCallSucceeded());
    } finally {
      testEnv.REGION = "us-west";
    }
  });
});
