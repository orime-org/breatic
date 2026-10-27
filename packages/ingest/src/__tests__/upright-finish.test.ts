// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A picture with an EXIF orientation is turned upright when its upload
 * finishes (inner#1367 §4.2, §4.4).
 *
 * The bytes as received stay at the ticket's key; the container turns them,
 * measures and previews the turned picture, and writes it back beside them
 * under `uprightKeyFor(key)` with its pixel size on the object. The answer
 * carries the upright copy, and the hash stays the received bytes'.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  INGEST_FAILURE_HEADER,
  previewKeyFor,
  signUploadTicket,
  uprightKeyFor,
} from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";
import { writeUpright } from "@ingest/media-container.js";
import { buildProbeAnswer, type ProbeRequest } from "@ingest/probe-answer.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import { UPRIGHT_OBJECT_HOST, type UprightOutcome } from "@ingest/upright-run.js";
import { openForTest } from "./helpers/open-upload.js";

let seq = 0;

const DEADLINE_AT = Date.now() + 7_200_000;
const LIMITS = { uprightJpegQuality: 90, uprightMaxBytes: 64 * 1024 * 1024 };

/** A JPEG whose APP1 Exif segment says `orientation`, then some scan bytes. */
function jpeg(orientation: number): Uint8Array {
  const tiff = new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, 42, IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation
    0x00, 0x00, 0x00, 0x00, // next IFD
  ]);
  const exif = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
  const length = exif.length + 2;
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...exif,
    0xff, 0xda, 0x00, 0x02, ...new Uint8Array(200).fill(7), 0xff, 0xd9,
  ]);
}

/** A PNG chunk, its CRC left as zeros: nothing on this path checks it. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out;
}

/** An animated PNG (an acTL chunk ahead of IDAT) whose eXIf says `orientation`. */
function animatedPng(orientation: number): Uint8Array {
  const tiff = jpeg(orientation).subarray(12, 12 + 26);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("acTL", new Uint8Array(8)),
    pngChunk("eXIf", tiff),
    pngChunk("IDAT", new Uint8Array(64)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A portrait 3000x4000 picture, the shape ffprobe answers with. */
const PORTRAIT: ProbeReport = {
  durationSeconds: null,
  streams: [
    { index: 0, codecType: "video", codecName: "mjpeg", width: 3000, height: 4000, attachedPic: false },
  ],
};

/** Upload `bytes` as a one-part JPEG and hand back what the browser holds. */
async function uploaded(bytes: Uint8Array): Promise<{
  storageKey: string;
  uploadId: string;
  token: string;
  parts: { partNumber: number; etag: string }[];
}> {
  const storageKey = `image/2026-10-10/${seq++}_tagged.jpg`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 1,
      partSize: 5 * 1024 * 1024,
      contentType: "image/jpeg",
      expiresAt: Date.now() + 300_000,
      deadlineAt: DEADLINE_AT,
    },
    env.INGEST_SHARED_SECRET,
  );
  const session = await openForTest(ticket);
  const ctx = createExecutionContext();
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
  return {
    storageKey,
    uploadId: session.uploadId,
    token: landed.token,
    parts: [{ partNumber: landed.partNumber, etag: landed.etag }],
  };
}

/** What a stand-in container was asked, and the namespace to pass in. */
interface UprightRun {
  media: Env["MEDIA"];
  asked: ProbeRequest | null;
  /** The grant the write-back handler was set up with. */
  writeGrant: { key: string; contentType: string; maxBytes: number } | null;
}

/**
 * Stand a container in for one run that turns the picture upright.
 *
 * It writes back through the real write-back handler, the way the container's
 * PUT reaches it, so what lands in R2 is what the Worker would store.
 * @param turned - The upright bytes, or null for a run whose turn fails.
 * @param report - What probing the turned picture answers.
 * @param preview - The preview it cuts.
 * @returns The namespace and what it was asked.
 */
function uprightContainer(
  turned: Uint8Array | null,
  report: ProbeReport = PORTRAIT,
  preview: Uint8Array | null = new Uint8Array([0x52, 0x49, 0x46, 0x46]),
): UprightRun {
  const run: UprightRun = { media: null as unknown as Env["MEDIA"], asked: null, writeGrant: null };
  run.media = {
    idFromName: (name: string) => name,
    get: () => ({
      setOutboundByHost: (host: string, _handler: string, params: unknown): Promise<void> => {
        if (host === UPRIGHT_OBJECT_HOST) run.writeGrant = params as UprightRun["writeGrant"];
        return Promise.resolve();
      },
      fetch: async (request: Request): Promise<Response> => {
        const asked = await request.json<ProbeRequest>();
        run.asked = asked;
        if (asked.upright === undefined) return buildProbeAnswer(report, null, asked.wantPreview ? preview : null);
        if (turned === null) {
          const failed: UprightOutcome = { state: "failed", step: "turn" };
          return buildProbeAnswer({ durationSeconds: null, streams: [] }, null, null, failed);
        }
        const written = await writeUpright(
          new Request(asked.upright.writeUrl, {
            method: "PUT",
            headers: { "x-upright-width": "3000", "x-upright-height": "4000" },
            body: turned,
          }),
          env,
          { params: run.writeGrant! } as never,
        );
        const outcome: UprightOutcome =
          written.status === 200 ? { state: "written" } : { state: "failed", step: "write" };
        return buildProbeAnswer(report, null, preview, outcome);
      },
    }),
  } as unknown as Env["MEDIA"];
  return run;
}

/**
 * Stand a container in that is never reached (its call throws) or answers
 * with an error status.
 * @param answer - "throws", or the status it answers with.
 * @returns The namespace to pass in.
 */
function brokenContainer(answer: "throws" | number): Env["MEDIA"] {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      setOutboundByHost: (): Promise<void> => Promise.resolve(),
      fetch: (): Promise<Response> =>
        answer === "throws"
          ? Promise.reject(new Error("container did not start"))
          : Promise.resolve(new Response("no", { status: answer })),
    }),
  } as unknown as Env["MEDIA"];
}

/** Ask the Worker to finish, the way our server does. */
async function finish(
  held: Awaited<ReturnType<typeof uploaded>>,
  run: {
    media?: Env["MEDIA"];
    bucket?: Env["BUCKET"];
    limits?: unknown;
    /** The deadline the finish names; null leaves it out of the body. */
    deadlineAt?: number | null;
  } = {},
): Promise<Response> {
  const deadlineAt = run.deadlineAt === undefined ? DEADLINE_AT : run.deadlineAt;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${held.uploadId}/complete`, {
      method: "POST",
      headers: {
        "x-upload-token": held.token,
        "x-ingest-secret": env.INGEST_SHARED_SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parts: held.parts,
        coverKey: held.storageKey.replace(/\.jpg$/, "_cover.png"),
        ...(deadlineAt !== null && { deadlineAt }),
        ...("limits" in run ? { limits: run.limits } : { limits: LIMITS }),
      }),
    }),
    {
      ...env,
      ...(run.media !== undefined && { MEDIA: run.media }),
      ...(run.bucket !== undefined && { BUCKET: run.bucket }),
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** SHA-256 of `bytes`, as lowercase hex. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("a picture with an EXIF orientation", () => {
  it("is turned upright beside the bytes as received, and answered as its upright copy", async () => {
    const original = jpeg(6);
    const held = await uploaded(original);
    const turned = jpeg(1);
    const run = uprightContainer(turned);

    const response = await finish(held, { media: run.media });

    expect(response.status).toBe(200);
    const answer = await response.json<Record<string, unknown>>();
    expect(answer).toMatchObject({
      sha256: await sha256(original),
      sizeBytes: original.byteLength,
      contentType: "image/jpeg",
      width: 3000,
      height: 4000,
      upright: {
        storageKey: uprightKeyFor(held.storageKey),
        sizeBytes: turned.byteLength,
        width: 3000,
        height: 4000,
      },
    });
    // The received bytes stay where the ticket put them.
    const kept = await env.BUCKET.get(held.storageKey);
    expect(new Uint8Array(await kept!.arrayBuffer())).toEqual(original);
  });

  it("asks the container to turn it, with the order the limits and its header call for", async () => {
    const held = await uploaded(jpeg(8));
    const run = uprightContainer(jpeg(1));

    await finish(held, { media: run.media });

    expect(run.asked?.upright).toEqual({
      writeUrl: `http://${UPRIGHT_OBJECT_HOST}/${uprightKeyFor(held.storageKey)
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      contentType: "image/jpeg",
      lossless: false,
      quality: LIMITS.uprightJpegQuality,
      maxBytes: LIMITS.uprightMaxBytes,
    });
    expect(run.writeGrant).toEqual({
      key: uprightKeyFor(held.storageKey),
      contentType: "image/jpeg",
      maxBytes: LIMITS.uprightMaxBytes,
    });
  });

  // A re-delivery of the finish answers from the object without running the
  // container again, so its pixel size has to be on the object.
  it("writes the upright copy with its pixel size, and its preview beside it", async () => {
    const held = await uploaded(jpeg(6));
    const preview = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9]);
    const run = uprightContainer(jpeg(1), PORTRAIT, preview);

    await finish(held, { media: run.media });

    const upright = await env.BUCKET.head(uprightKeyFor(held.storageKey));
    expect(upright?.customMetadata).toEqual({ width: "3000", height: "4000" });
    expect(upright?.httpMetadata?.contentType).toBe("image/jpeg");
    const stored = await env.BUCKET.get(previewKeyFor(uprightKeyFor(held.storageKey)));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(preview);
  });

  it("answers a re-delivery from the upright copy already standing, without a run", async () => {
    const held = await uploaded(jpeg(6));
    await env.BUCKET.put(uprightKeyFor(held.storageKey), jpeg(1), {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { width: "3000", height: "4000" },
    });
    await env.BUCKET.put(previewKeyFor(uprightKeyFor(held.storageKey)), new Uint8Array([1]));
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, { media: run.media });

    expect(run.asked).toBeNull();
    expect(await response.json()).toMatchObject({
      upright: { storageKey: uprightKeyFor(held.storageKey), width: 3000, height: 4000 },
    });
  });

  // An earlier delivery wrote the upright copy and died before storing its
  // preview; the re-delivery cuts the preview from the copy standing there.
  it("cuts the preview a re-delivery finds missing beside the upright copy", async () => {
    const held = await uploaded(jpeg(6));
    const uprightKey = uprightKeyFor(held.storageKey);
    await env.BUCKET.put(uprightKey, jpeg(1), {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { width: "3000", height: "4000" },
    });
    const preview = new Uint8Array([0x52, 0x49, 0x46, 0x46, 7]);
    const run = uprightContainer(jpeg(1), PORTRAIT, preview);

    const response = await finish(held, { media: run.media });

    expect(run.asked?.upright).toBeUndefined();
    expect(run.asked?.wantPreview).toBe(true);
    expect(decodeURIComponent(new URL(run.asked!.objectUrl).pathname).slice(1)).toBe(uprightKey);
    const stored = await env.BUCKET.get(previewKeyFor(uprightKey));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(preview);
    expect(await response.json()).toMatchObject({ upright: { storageKey: uprightKey } });
  });

  it("fails the upload, naming upright_failed, when the container could not turn it", async () => {
    const held = await uploaded(jpeg(6));
    const run = uprightContainer(null);

    const response = await finish(held, { media: run.media });

    expect(response.status).toBe(502);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("upright_failed");
  });

  it("fails the upload when the finish carries no limits to turn it under", async () => {
    const held = await uploaded(jpeg(6));
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, { media: run.media, limits: undefined });

    expect(response.status).toBe(502);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("upright_failed");
    expect(run.asked).toBeNull();
  });

  it.each([
    ["no quality", { uprightMaxBytes: LIMITS.uprightMaxBytes }],
    ["no ceiling", { uprightJpegQuality: LIMITS.uprightJpegQuality }],
    ["a quality nothing encodes with", { ...LIMITS, uprightJpegQuality: 101 }],
  ])("fails the upload when its limits carry %s", async (_name, limits) => {
    const held = await uploaded(jpeg(6));
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, { media: run.media, limits });

    expect(response.status).toBe(502);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("upright_failed");
    expect(run.asked).toBeNull();
  });

  // Every way a turn can fail ends the upload the same way, and the log names
  // which one it was (A8).
  it.each([
    ["the finish names no deadline", "no_deadline", () => ({ deadlineAt: null })],
    ["the deadline has come", "unfinished", () => ({ deadlineAt: Date.now() - 1 })],
    ["the container cannot be reached", "start_failed", () => ({ media: brokenContainer("throws") })],
    ["the container answers with an error", "refused", () => ({ media: brokenContainer(500) })],
    ["the container cannot turn it", "turn_failed", () => ({ media: uprightContainer(null).media })],
    [
      "the upright copy cannot be written back",
      "write_failed",
      () => ({ media: uprightContainer(jpeg(1)).media, limits: { ...LIMITS, uprightMaxBytes: 1 } }),
    ],
  ] as const)("fails the upload, and writes down why, when %s", async (_name, reason, setup) => {
    const held = await uploaded(jpeg(6));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await finish(held, setup());

    expect(response.status).toBe(502);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("upright_failed");
    const noted = logged.mock.calls.find(([label]) => label === "ingest_upright_failed");
    expect(noted?.[1]).toMatchObject({ storageKey: held.storageKey, reason });
    expect(await env.BUCKET.head(uprightKeyFor(held.storageKey))).toBeNull();
    logged.mockRestore();
  });

  it("fails the upload when its orientation cannot be read", async () => {
    const held = await uploaded(jpeg(6));
    const bucket = new Proxy(env.BUCKET, {
      get(target, name) {
        if (name === "get") {
          return (key: string, options?: R2GetOptions) =>
            options?.range !== undefined
              ? Promise.reject(new Error("R2 range read failed"))
              : target.get(key, options);
        }
        const value = Reflect.get(target, name) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await finish(held, { media: uprightContainer(jpeg(1)).media, bucket });

    expect(response.status).toBe(502);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("upright_failed");
    // The log carries R2's own error, so the cause can be told apart.
    const unread = logged.mock.calls.find(([label]) => label === "ingest_orientation_unread");
    expect(String((unread?.[1] as { err?: unknown } | undefined)?.err)).toContain("R2 range read failed");
    logged.mockRestore();
  });

  it("files a picture whose EXIF segment runs past its end as received, and writes it down", async () => {
    // Cut inside the Orientation entry: the segment promises more bytes than arrived.
    const held = await uploaded(jpeg(6).slice(0, 24));
    const run = uprightContainer(jpeg(1));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await finish(held, { media: run.media });

    expect(response.status).toBe(200);
    expect(run.asked?.upright).toBeUndefined();
    expect(logged.mock.calls.some(([label]) => label === "ingest_orientation_out_of_bounds")).toBe(true);
    logged.mockRestore();
  });
});

describe("a picture shown as it is stored", () => {
  // vips autorot writes out only an animation's first frame, so an animated
  // picture is filed as received whatever its orientation (A15).
  it("is answered as received when it is animated, though its orientation says to turn it", async () => {
    const held = await uploaded(animatedPng(6));
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, { media: run.media });

    expect(response.status).toBe(200);
    expect(run.asked?.upright).toBeUndefined();
    expect(await response.json()).toMatchObject({ contentType: "image/png", upright: null });
  });

  it("is answered as received when it carries orientation 1", async () => {
    const held = await uploaded(jpeg(1));
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, { media: run.media });

    expect(response.status).toBe(200);
    expect(run.asked?.upright).toBeUndefined();
    expect(await response.json()).toMatchObject({ upright: null });
  });
});

// A3: a link handed to /fetch ends in the same finishUpload, and the limits it
// is turned under are read from that request's own body.
describe("a picture fetched from a link", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("is turned upright the same way, and answered as its upright copy", async () => {
    const bytes = jpeg(6);
    fetchMock
      .get("https://provider.test.example")
      .intercept({ path: "/out.jpg", method: "GET" })
      .reply(200, bytes, { headers: { "content-type": "image/jpeg" } });
    const storageKey = `image/2026-10-10/${seq++}_fetched.jpg`;
    const ticket = await signUploadTicket(
      {
        storageKey,
        studioId: "studio-1",
        userId: "user-1",
        totalParts: 1,
        partSize: 5 * 1024 * 1024,
        contentType: "image/jpeg",
        expiresAt: Date.now() + 300_000,
        deadlineAt: DEADLINE_AT,
      },
      env.INGEST_SHARED_SECRET,
    );
    const run = uprightContainer(jpeg(1));
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request("https://ingest.example.com/fetch", {
        method: "POST",
        headers: { "x-ingest-secret": env.INGEST_SHARED_SECRET, "x-upload-ticket": ticket },
        body: JSON.stringify({
          url: "https://provider.test.example/out.jpg",
          coverKey: storageKey.replace(/\.jpg$/, "_cover.png"),
          deadlineAt: DEADLINE_AT,
          limits: LIMITS,
        }),
      }),
      { ...env, MEDIA: run.media },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const answer = await response.json<{ sha256: string; upright: { storageKey: string } | null }>();
    expect(answer.upright?.storageKey).toBe(uprightKeyFor(storageKey));
    expect(answer.sha256).toBe(await sha256(bytes));
  });
});

describe("the write-back handler", () => {
  const grant = { key: "image/2026-10-10/1_x_upright.jpg", contentType: "image/jpeg", maxBytes: 64 };

  it("refuses a key other than the one it was set up for", async () => {
    const answered = await writeUpright(
      new Request(`http://${UPRIGHT_OBJECT_HOST}/image/2026-10-10/2_other.jpg`, {
        method: "PUT",
        body: new Uint8Array(8),
      }),
      env,
      { params: grant } as never,
    );

    expect(answered.status).toBe(403);
    expect(await env.BUCKET.head("image/2026-10-10/2_other.jpg")).toBeNull();
  });

  it("refuses an upright copy heavier than the ceiling", async () => {
    const answered = await writeUpright(
      new Request(`http://${UPRIGHT_OBJECT_HOST}/${grant.key}`, {
        method: "PUT",
        body: new Uint8Array(grant.maxBytes + 1),
      }),
      env,
      { params: grant } as never,
    );

    expect(answered.status).toBe(413);
  });
});
