// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "@ingest/index.js";
import type { ProbeRequest } from "@ingest/probe-answer.js";

const SPEC = { version: 1, longEdge: 1024, quality: 85 };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 5, 6]);
const PICTURE = {
  durationSeconds: null,
  streams: [{ index: 0, codecType: "video", codecName: "png", width: 3000, height: 2000, attachedPic: false }],
};
let sequence = 0;

/** A canonical registered source stand-in; platform storage is real R2. */
async function sourceKey(): Promise<string> {
  const key = `image/agent-picture-tests/${sequence++}.png`;
  await env.BUCKET.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    httpMetadata: { contentType: "image/png" },
  });
  return key;
}

/** The v1 format contract, asserted independently of the shared key helper. */
function pictureKey(key: string): string {
  return `${key}.agent-v1-1024-q85.jpg`;
}

/** Ask the actual Worker router under the test bindings. */
async function ask(
  storageKey: string,
  media: Env["MEDIA"],
  extra: Record<string, unknown> = {},
  secret: string | null = env.INGEST_SHARED_SECRET,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("x-ingest-secret", secret);
  const response = await worker.fetch(new Request("https://ingest.example.com/media", {
    method: "POST",
    headers,
    body: JSON.stringify({
      storageKey,
      contentType: "image/png",
      deadlineAt: Date.now() + 7_200_000,
      agentPicture: SPEC,
      ...extra,
    }),
  }), { ...env, MEDIA: media }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Stand in only for the container; the Worker, multipart reader and R2 run. */
function container(
  bytes: Uint8Array | null = JPEG,
  options: {
    beforeAnswer?: () => Promise<void>;
    preview?: Uint8Array;
    report?: typeof PICTURE;
    contentType?: string;
  } = {},
): { media: Env["MEDIA"]; asked: ProbeRequest[]; authorised: string[] } {
  const asked: ProbeRequest[] = [];
  const authorised: string[] = [];
  const media = {
    idFromName: (name: string) => name,
    get: () => ({
      setOutboundByHost: (_host: string, _handler: string, params: { key: string }): Promise<void> => {
        authorised.push(params.key);
        return Promise.resolve();
      },
      fetch: async (request: Request): Promise<Response> => {
        asked.push(await request.json<ProbeRequest>());
        await options.beforeAnswer?.();
        const form = new FormData();
        form.set("meta", JSON.stringify(options.report ?? PICTURE));
        if (bytes !== null) {
          form.set("agentPicture", new File([bytes], "agent-picture.jpg", {
            type: options.contentType ?? "image/jpeg",
          }));
        }
        if (options.preview !== undefined) {
          form.set("preview", new File([options.preview], "preview.webp", { type: "image/webp" }));
        }
        return new Response(form);
      },
    }),
  } as unknown as Env["MEDIA"];
  return { media, asked, authorised };
}

describe("agent picture requests through the real Worker and R2", () => {
  it("writes a separate JPEG and answers its measured stored byte count", async () => {
    const key = await sourceKey();
    const run = container();
    const response = await ask(key, run.media);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agentPicture: { outcome: "generated", sizeBytes: JPEG.byteLength, mediaType: "image/jpeg" },
    });
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]).toMatchObject({ agentPicture: SPEC, wantCover: false });
    expect(run.authorised).toEqual([key]);
    const stored = await env.BUCKET.get(pictureKey(key));
    expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(JPEG);
    expect(await env.BUCKET.head(`${key}.preview.webp`)).toBeNull();
  });

  it("uses a standing JPEG's actual facts and starts no container for it alone", async () => {
    const key = await sourceKey();
    const standing = new Uint8Array([...JPEG, 4, 5, 6]);
    await env.BUCKET.put(pictureKey(key), standing, { httpMetadata: { contentType: "image/jpeg" } });
    const run = container();

    const response = await ask(key, run.media);

    expect(await response.json()).toMatchObject({
      agentPicture: { outcome: "existing", sizeBytes: standing.byteLength, mediaType: "image/jpeg" },
    });
    expect(run.asked).toEqual([]);
    expect(new Uint8Array(await (await env.BUCKET.get(pictureKey(key)))!.arrayBuffer())).toEqual(standing);
  });

  it("keeps the 576 WebP preview and the agent JPEG independent", async () => {
    const key = await sourceKey();
    const run = container(JPEG, { preview: WEBP });
    const response = await ask(key, run.media, { wantPreview: true });

    expect(await response.json()).toMatchObject({
      preview: "generated",
      agentPicture: { outcome: "generated", sizeBytes: JPEG.byteLength, mediaType: "image/jpeg" },
    });
    expect(run.asked[0]).toMatchObject({ wantPreview: true, agentPicture: SPEC });
    expect(new Uint8Array(await (await env.BUCKET.get(`${key}.preview.webp`))!.arrayBuffer())).toEqual(WEBP);
    expect(new Uint8Array(await (await env.BUCKET.get(pictureKey(key)))!.arrayBuffer())).toEqual(JPEG);
  });

  it("continues preparing a missing preview when the JPEG already stands", async () => {
    const key = await sourceKey();
    await env.BUCKET.put(pictureKey(key), JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    const run = container(null, { preview: WEBP });
    const response = await ask(key, run.media, { wantPreview: true });

    expect(await response.json()).toMatchObject({
      preview: "generated",
      agentPicture: { outcome: "existing", sizeBytes: JPEG.byteLength, mediaType: "image/jpeg" },
    });
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]?.agentPicture).toBeUndefined();
  });

  it("reports a missing JPEG as failed instead of claiming preparation succeeded", async () => {
    const key = await sourceKey();
    const response = await ask(key, container(null).media);
    expect(await response.json()).toMatchObject({ agentPicture: { outcome: "failed" } });
    expect(await env.BUCKET.head(pictureKey(key))).toBeNull();
  });

  it("never accepts a PNG multipart part as a JPEG fact", async () => {
    const key = await sourceKey();
    const response = await ask(key, container(WEBP, { contentType: "image/png" }).media);
    expect(await response.json()).toMatchObject({ agentPicture: { outcome: "failed" } });
    expect(await env.BUCKET.head(pictureKey(key))).toBeNull();
  });

  it("never overwrites an existing object whose facts cannot describe a JPEG", async () => {
    const key = await sourceKey();
    await env.BUCKET.put(pictureKey(key), WEBP, { httpMetadata: { contentType: "image/webp" } });
    const response = await ask(key, container().media);
    expect(await response.json()).toMatchObject({ agentPicture: { outcome: "failed" } });
    expect(new Uint8Array(await (await env.BUCKET.get(pictureKey(key)))!.arrayBuffer())).toEqual(WEBP);
  });

  it("uses conditional creation and returns the winner's measured facts after a race", async () => {
    const key = await sourceKey();
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const gate = async (): Promise<void> => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await bothStarted;
    };
    const other = new Uint8Array([...JPEG, 11, 12, 13, 14, 15]);
    const first = container(JPEG, { beforeAnswer: gate });
    const second = container(other, { beforeAnswer: gate });

    const replies = await Promise.all([ask(key, first.media), ask(key, second.media)]);
    const results = await Promise.all(replies.map((response) => response.json<{ agentPicture: {
      outcome: string;
      sizeBytes: number;
      mediaType: string;
    } }>()));

    expect(results.map((result) => result.agentPicture.outcome).sort()).toEqual(["existing", "generated"]);
    const stored = await env.BUCKET.get(pictureKey(key));
    const winner = new Uint8Array(await stored!.arrayBuffer());
    expect([Array.from(JPEG), Array.from(other)]).toContainEqual(Array.from(winner));
    expect(results.map((result) => result.agentPicture)).toEqual([
      { outcome: results[0]!.agentPicture.outcome, sizeBytes: winner.byteLength, mediaType: "image/jpeg" },
      { outcome: results[1]!.agentPicture.outcome, sizeBytes: winner.byteLength, mediaType: "image/jpeg" },
    ]);
  });

  it("requires backend authorization before reading or generating", async () => {
    const key = await sourceKey();
    const run = container();
    const response = await ask(key, run.media, {}, null);
    expect(response.status).toBe(401);
    expect(run.asked).toEqual([]);
    expect(await env.BUCKET.head(pictureKey(key))).toBeNull();
  });

  it("checks the original source even when a derived JPEG stands", async () => {
    const key = `image/agent-picture-tests/deleted-${sequence++}.png`;
    await env.BUCKET.put(pictureKey(key), JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    const run = container();
    expect((await ask(key, run.media)).status).toBe(404);
    expect(run.asked).toEqual([]);
  });

  it.each([
    { version: 2, longEdge: 1024, quality: 85 },
    { version: 1, longEdge: 0, quality: 85 },
    { version: 1, longEdge: 1024.5, quality: 85 },
    { version: 1, longEdge: 1024, quality: 101 },
    { version: 1, longEdge: 1024, quality: 0 },
    { version: 1, longEdge: 1024 },
  ])("rejects an unsupported or incomplete specification before starting: %o", async (agentPicture) => {
    const key = await sourceKey();
    const run = container();
    expect((await ask(key, run.media, { agentPicture })).status).toBe(400);
    expect(run.asked).toEqual([]);
    expect(await env.BUCKET.head(pictureKey(key))).toBeNull();
  });
});
