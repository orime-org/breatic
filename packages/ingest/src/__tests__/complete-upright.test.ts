// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing a picture that carries an EXIF orientation (inner#1367 design
 * §4.1).
 *
 * A picture read at 2-8 is handed to its key's arbiter, and the answer is read
 * off the object afterwards: the hash and size of what stands at the key, and
 * the hash of what was received, carried on the object when it was turned.
 * The arbiter here is a stand-in that does what the real one does to the
 * object; the real one is exercised under `upright-arbiter.arbiter.test.ts`.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signUploadTicket, type MediaLimits } from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";
import type { ArbiterAnswer, ArbiterAsk } from "@ingest/upright-arbiter.js";

const LIMITS: MediaLimits = { runDeadlineMs: 150_000, toolTimeoutMs: 60_000, uprightJpegQuality: 90 };
const MEASURED = { width: 768, height: 1024, durationSeconds: null };
let seq = 0;

/** A TIFF block holding one IFD0 entry: Orientation = `value`. */
function tiff(value: number): Uint8Array {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  out.set([0x4d, 0x4d], 0);
  view.setUint16(2, 42);
  view.setUint32(4, 8);
  view.setUint16(8, 1);
  view.setUint16(10, 0x0112);
  view.setUint16(12, 3);
  view.setUint32(14, 1);
  view.setUint16(18, value);
  return out;
}

/** A JPEG head with an APP1 Exif segment, padded to `size` with zeroes. */
function jpegWith(orientation: number | null, size = 1024): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0xff, 0xd8], 0);
  let at = 2;
  if (orientation !== null) {
    const exif = tiff(orientation);
    out.set([0xff, 0xe1, 0, 2 + 6 + exif.length], at);
    out.set(new TextEncoder().encode("Exif\0\0"), at + 4);
    out.set(exif, at + 10);
    at += 4 + 6 + exif.length;
  }
  out.set([0xff, 0xdb, 0x00, 0x43], at);
  return out;
}

/** What the stand-in arbiter writes back: a JPEG with no orientation, shorter than the original. */
const UPRIGHT = jpegWith(null, 600);

async function sha256(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Upload one part of `bytes` as a JPEG and hold what the browser would. */
async function uploaded(bytes: Uint8Array): Promise<{ storageKey: string; uploadId: string; token: string; parts: { partNumber: number; etag: string }[] }> {
  const storageKey = `image/2026-10-10/${seq++}_upright.jpg`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 1,
      partSize: 5 * 1024 * 1024,
      contentType: "image/jpeg",
      expiresAt: Date.now() + 300_000,
      sessionTokenTtlSeconds: 900,
    },
    env.INGEST_SHARED_SECRET,
  );
  let ctx = createExecutionContext();
  const opened = await worker.fetch(
    new Request("https://ingest.example.com/uploads", { method: "POST", headers: { "x-upload-ticket": ticket } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const session = await opened.json<{ uploadId: string; token: string }>();
  ctx = createExecutionContext();
  const sent = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${session.uploadId}/parts/1`, {
      method: "PUT",
      headers: { "x-upload-token": session.token },
      body: bytes,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const landed = await sent.json<{ token: string; partNumber: number; etag: string }>();
  return { storageKey, uploadId: session.uploadId, token: landed.token, parts: [{ partNumber: 1, etag: landed.etag }] };
}

/** A media namespace whose arbiter is scripted and whose probe is counted. */
function standIn(answer: (ask: ArbiterAsk) => Promise<ArbiterAnswer>): {
  media: Env["MEDIA"];
  asks: ArbiterAsk[];
  probes: number;
} {
  const seen = { media: null as unknown as Env["MEDIA"], asks: [] as ArbiterAsk[], probes: 0 };
  seen.media = {
    idFromName: (name: string) => name,
    get: () => ({
      askUpright: async (ask: ArbiterAsk) => {
        seen.asks.push(ask);
        return answer(ask);
      },
      setOutboundByHost: async () => undefined,
      fetch: async () => {
        seen.probes += 1;
        return new Response("no container", { status: 500 });
      },
    }),
  } as unknown as Env["MEDIA"];
  return seen;
}

/** What the real arbiter leaves at the key once it turned the picture. */
async function turned(ask: ArbiterAsk): Promise<ArbiterAnswer> {
  const original = await env.BUCKET.head(ask.storageKey);
  await env.BUCKET.put(ask.storageKey, UPRIGHT, {
    httpMetadata: original?.httpMetadata,
    customMetadata: { "received-sha256": ask.receivedSha256 },
  });
  return { phase: "done", media: MEASURED };
}

async function finish(
  held: { uploadId: string; token: string; parts: { partNumber: number; etag: string }[] },
  media: Env["MEDIA"],
  limits: MediaLimits | null = LIMITS,
  bucket: R2Bucket = env.BUCKET,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${held.uploadId}/complete`, {
      method: "POST",
      headers: { "x-upload-token": held.token, "x-ingest-secret": env.INGEST_SHARED_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ parts: held.parts, ...(limits !== null && { limits }) }),
    }),
    { ...env, MEDIA: media, BUCKET: bucket },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

interface Answer {
  sha256: string;
  receivedSha256: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

describe("a picture shown at an EXIF orientation", () => {
  it("asks the arbiter, then answers for what stands at the key and for what was received", async () => {
    const original = jpegWith(6);
    const held = await uploaded(original);
    const run = standIn(turned);
    const answered = await finish(held, run.media);
    expect(answered.status).toBe(200);
    const body = await answered.json<Answer>();
    expect(run.asks.map((ask) => ask.kind)).toEqual(["request"]);
    expect(run.asks[0]).toMatchObject({ storageKey: held.storageKey, contentType: "image/jpeg", quality: 90, lossless: false });
    expect(body.sha256).toBe(await sha256(UPRIGHT));
    expect(body.sizeBytes).toBe(UPRIGHT.length);
    expect(body.receivedSha256).toBe(await sha256(original));
    expect([body.width, body.height]).toEqual([768, 1024]);
    expect(run.probes).toBe(0);
  });

  it("gives a re-delivered finish the same answer without asking again", async () => {
    const held = await uploaded(jpegWith(6));
    const run = standIn(turned);
    const first = await (await finish(held, run.media)).json<Answer>();
    const again = await (await finish(held, run.media)).json<Answer>();
    expect({ sha256: again.sha256, receivedSha256: again.receivedSha256, sizeBytes: again.sizeBytes }).toEqual({
      sha256: first.sha256,
      receivedSha256: first.receivedSha256,
      sizeBytes: first.sizeBytes,
    });
    expect(run.asks).toHaveLength(1);
  });

  it("measures the object itself and answers one hash when the arbiter left it as received", async () => {
    const original = jpegWith(6);
    const held = await uploaded(original);
    const run = standIn(async () => ({ phase: "abandoned", media: null }));
    const body = await (await finish(held, run.media)).json<Answer>();
    expect(body.sha256).toBe(await sha256(original));
    expect(body.receivedSha256).toBe(body.sha256);
    expect(run.probes).toBe(1);
  });

  it("seals the key when the finish named no limits to wait under", async () => {
    const held = await uploaded(jpegWith(6));
    const run = standIn(async () => ({ phase: "abandoned", media: null }));
    await finish(held, run.media, null);
    expect(run.asks.map((ask) => ask.kind)).toEqual(["seal"]);
  });

  it("seals the key when its orientation could not be read", async () => {
    const held = await uploaded(jpegWith(6));
    const run = standIn(async () => ({ phase: "abandoned", media: null }));
    const failingHeadReads = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop !== "get") {
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (key: string, options?: R2GetOptions) => {
          const range = options?.range as { length?: number } | undefined;
          if (range?.length === 64 * 1024) return Promise.reject(new Error("range read refused"));
          return target.get(key, options);
        };
      },
    });
    await finish(held, run.media, LIMITS, failingHeadReads);
    expect(run.asks.map((ask) => ask.kind)).toEqual(["seal"]);
  });
});

describe("a picture with no orientation to apply", () => {
  it("does not ask the arbiter and answers the received hash as the stored one", async () => {
    const original = jpegWith(null);
    const held = await uploaded(original);
    const run = standIn(turned);
    const body = await (await finish(held, run.media)).json<Answer>();
    expect(run.asks).toHaveLength(0);
    expect(body.sha256).toBe(await sha256(original));
    expect(body.receivedSha256).toBe(body.sha256);
  });
});
