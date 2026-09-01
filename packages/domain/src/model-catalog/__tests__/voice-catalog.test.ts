// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 A2 — the voice list a tts model offers.
 *
 * Every vendor names, shapes and pages its voices differently, and the panel
 * has to render one list. So the difference is settled here, against the
 * provider this deployment actually resolved to (#1960 §6.1.1): the id handed
 * back is the value that provider accepts, which is what ends up in the node's
 * params and travels back out on the next generation.
 *
 * A double proves the shape we send and the shape we read back, never that the
 * vendor accepts either — that half is settled by a real request during A3.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { initCore } from "@breatic/core";
import type * as sharedModule from "@breatic/shared";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

const { listVoices, getVoice } = await import("../voice-catalog.js");
const { resetModelCatalog } = await import("../model-catalog.js");

const BASE_ENV = { DATABASE_URL: "postgres://localhost:5432/breatic_test" };

/**
 * Injects a deployment's provider keys and clears the catalog cache.
 * @param keys - Env vars to set on top of the schema's required ones.
 */
function deployWith(keys: Record<string, string>): void {
  initCore({ ...BASE_ENV, ...keys });
  resetModelCatalog();
}

/**
 * Answers the next upstream call with this JSON body.
 * @param body - The payload the vendor would return.
 */
function upstreamReturns(body: unknown): void {
  httpRequestMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/**
 * Read back the URL of the request the catalog made.
 * @returns The requested URL, parsed.
 * @throws {Error} When no request was made.
 */
function requestedUrl(): URL {
  const call = httpRequestMock.mock.calls[0];
  if (!call) throw new Error("no upstream request was made");
  return new URL((call as [string])[0]);
}

beforeEach(() => {
  httpRequestMock.mockReset();
});

afterAll(() => {
  initCore(process.env);
  resetModelCatalog();
});

describe("listVoices against a direct ElevenLabs deployment (#1960 A2)", () => {
  beforeEach(() => {
    deployWith({ ELEVENLABS_API_KEY: "el-key" });
  });

  it("reads the v2 list off the provider's own host, carrying the key", async () => {
    upstreamReturns({ voices: [], has_more: false });
    await listVoices("elevenlabs-v3", {});

    const url = requestedUrl();
    // base_url in providers.yaml already ends in /v1 for the TTS transport,
    // while search and pagination only exist on v2.
    expect(url.origin + url.pathname).toBe("https://api.elevenlabs.io/v2/voices");
    const [, init] = httpRequestMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("el-key");
  });

  it("hands back one voice shape whatever the vendor called its fields", async () => {
    upstreamReturns({
      voices: [
        {
          voice_id: "21m00Tcm4TlvDq8ikWAM",
          name: "Rachel",
          description: "calm narration",
          preview_url: "https://cdn.elevenlabs.test/rachel.mp3",
          labels: { accent: "american", gender: "female" },
        },
      ],
      has_more: true,
      next_page_token: "tok-2",
    });

    const page = await listVoices("elevenlabs-v3", {});
    expect(page.voices).toEqual([
      {
        id: "21m00Tcm4TlvDq8ikWAM",
        name: "Rachel",
        description: "calm narration",
        previewUrl: "https://cdn.elevenlabs.test/rachel.mp3",
      },
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("tok-2");
  });

  it("falls back to the labels when a voice carries no description", async () => {
    upstreamReturns({
      voices: [
        {
          voice_id: "v1",
          name: "Elli",
          labels: { accent: "american", age: "young" },
        },
      ],
      has_more: false,
    });

    const page = await listVoices("elevenlabs-v3", {});
    expect(page.voices[0]?.description).toBe("american, young");
  });

  it("passes the search term and the cursor the vendor's own way", async () => {
    upstreamReturns({ voices: [], has_more: false });
    await listVoices("elevenlabs-v3", { query: "narrator", cursor: "tok-2" });

    const url = requestedUrl();
    expect(url.searchParams.get("search")).toBe("narrator");
    expect(url.searchParams.get("next_page_token")).toBe("tok-2");
  });

  it("reads a single voice off the v1 path, where that endpoint lives", async () => {
    upstreamReturns({
      voice_id: "21m00Tcm4TlvDq8ikWAM",
      name: "Rachel",
      preview_url: "https://cdn.elevenlabs.test/rachel.mp3",
    });

    const voice = await getVoice("elevenlabs-v3", "21m00Tcm4TlvDq8ikWAM");
    const url = requestedUrl();
    expect(url.origin + url.pathname).toBe(
      "https://api.elevenlabs.io/v1/voices/21m00Tcm4TlvDq8ikWAM",
    );
    expect(voice?.name).toBe("Rachel");
  });
});

describe("listVoices against a Fish deployment (#1960 A2)", () => {
  beforeEach(() => {
    deployWith({ FISH_API_KEY: "fish-key" });
  });

  it("asks only for licensed voices, most used first", async () => {
    upstreamReturns({ items: [], total: 0 });
    await listVoices("fish-s2-pro", {});

    const url = requestedUrl();
    expect(url.origin + url.pathname).toBe("https://api.fish.audio/model");
    // Two million community voices is not a list anyone can pick from; these
    // two narrow it to what the vendor licensed, ordered by real use.
    expect(url.searchParams.get("licensed")).toBe("true");
    expect(url.searchParams.get("sort_by")).toBe("task_count");
  });

  it("hands back the same voice shape this vendor spells differently", async () => {
    upstreamReturns({
      items: [
        {
          _id: "7f92f8afb8ec43bf81429cc1c9199cb1",
          title: "Energetic Male",
          description: "upbeat commercial read",
          languages: ["en", "zh"],
          samples: [{ title: "s", text: "t", audio: "https://cdn.fish.test/a.mp3" }],
        },
      ],
      has_more: false,
    });

    const page = await listVoices("fish-s2-pro", {});
    expect(page.voices).toEqual([
      {
        id: "7f92f8afb8ec43bf81429cc1c9199cb1",
        name: "Energetic Male",
        description: "upbeat commercial read",
        languages: ["en", "zh"],
        previewUrl: "https://cdn.fish.test/a.mp3",
      },
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it("pages by number under the same outward cursor", async () => {
    upstreamReturns({ items: [], has_more: true });
    const page = await listVoices("fish-s2-pro", { cursor: "2" });

    expect(requestedUrl().searchParams.get("page_number")).toBe("2");
    // The caller never learns which of the two paging styles it is talking to.
    expect(page.nextCursor).toBe("3");
  });

  it("searches by title, which is what this vendor calls a name", async () => {
    upstreamReturns({ items: [], has_more: false });
    await listVoices("fish-s2-pro", { query: "narrator" });

    expect(requestedUrl().searchParams.get("title")).toBe("narrator");
  });
});

describe("listVoices against a WaveSpeed deployment (#1960 §6.1.1)", () => {
  beforeEach(() => {
    deployWith({ WAVESPEED_API_KEY: "ws-key" });
  });

  // WaveSpeed is an aggregating gateway with no voice endpoint of its own, and
  // it takes voice NAMES where a direct connection takes 20-char ids. The yaml
  // table holds exactly those names, so it is the list for this deployment.
  it("serves the catalog's own table without calling any upstream", async () => {
    const page = await listVoices("elevenlabs-v3", {});

    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(page.voices.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
    const alice = page.voices.find((v) => v.id === "Alice");
    expect(alice).toBeDefined();
    // No previews: every sample_url in that table is null.
    expect(alice?.previewUrl).toBeUndefined();
  });

  it("filters that table by the search term", async () => {
    const page = await listVoices("elevenlabs-v3", { query: "ali" });
    expect(page.voices.map((v) => v.id)).toContain("Alice");
    expect(page.voices.every((v) => v.id.toLowerCase().includes("ali"))).toBe(true);
  });

  it("reads a single voice out of the same table", async () => {
    const voice = await getVoice("elevenlabs-v3", "Alice");
    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(voice?.id).toBe("Alice");
  });

  it("answers null for a name that table does not carry", async () => {
    expect(await getVoice("elevenlabs-v3", "NoSuchVoice")).toBeNull();
  });
});

describe("when the model has no voice catalog to offer", () => {
  it("refuses a model whose params declare no remote voice source", async () => {
    deployWith({ WAVESPEED_API_KEY: "ws-key" });
    await expect(listVoices("midjourney-v7", {})).rejects.toThrow(/no voice/i);
  });

  it("lets an upstream failure through to the caller", async () => {
    deployWith({ ELEVENLABS_API_KEY: "el-key" });
    httpRequestMock.mockResolvedValueOnce(
      new Response("upstream is down", { status: 503 }),
    );
    // Domain throws; deciding what the user sees belongs to the route.
    await expect(listVoices("elevenlabs-v3", {})).rejects.toThrow(/503/);
  });
});
