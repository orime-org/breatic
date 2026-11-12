// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Tests for {@link createGlobalApi}: the region that holds the global data
 * calls the global functions in process, and every other region reaches them
 * with a signed request to the global region's internal listener.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalApiError, createGlobalApi } from "@core/region/global-api.js";

const SECRET = "test-internal-secret";

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
});

describe("createGlobalApi", () => {
  it("calls the global function in process when this region holds the global data", async () => {
    const fetchMock = answerWith(200, { result: "remote" });
    const local = localFunctions();
    const api = createGlobalApi(local, {
      region: "us-west",
      globalRegion: "us-west",
      globalApiUrl: "",
      secret: SECRET,
    });

    await expect(api.readUserName("u1")).resolves.toBe("local:u1");
    expect(local.readUserName).toHaveBeenCalledWith("u1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the arguments to the global region and returns its result", async () => {
    const fetchMock = answerWith(200, { result: "remote:u1" });
    const local = localFunctions();
    const api = createGlobalApi(local, {
      region: "sg",
      globalRegion: "us-west",
      globalApiUrl: "http://10.0.0.5:3002",
      secret: SECRET,
    });

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
    const api = createGlobalApi(localFunctions(), {
      region: "sg",
      globalRegion: "us-west",
      globalApiUrl: "http://10.0.0.5:3002",
      secret: SECRET,
    });

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
    const api = createGlobalApi(localFunctions(), {
      region: "sg",
      globalRegion: "us-west",
      globalApiUrl: "http://10.0.0.5:3002",
      secret: SECRET,
    });

    await api.readUserName("u1");
    await api.readUserName("u1");
    const nonces = fetchMock.mock.calls.map(
      ([, init]) => new Headers((init as RequestInit).headers).get("x-internal-nonce"),
    );
    expect(new Set(nonces).size).toBe(2);
  });

  it("rejects with the code the global region answered when it refuses", async () => {
    answerWith(409, { code: "studio_creation_in_progress" });
    const api = createGlobalApi(localFunctions(), {
      region: "sg",
      globalRegion: "us-west",
      globalApiUrl: "http://10.0.0.5:3002",
      secret: SECRET,
    });

    const failure = await api.readUserName("u1").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GlobalApiError);
    expect((failure as GlobalApiError).status).toBe(409);
    expect((failure as GlobalApiError).code).toBe("studio_creation_in_progress");
  });

  it("rejects when the global region cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const api = createGlobalApi(localFunctions(), {
      region: "sg",
      globalRegion: "us-west",
      globalApiUrl: "http://10.0.0.5:3002",
      secret: SECRET,
    });

    await expect(api.readUserName("u1")).rejects.toThrow();
  });
});
