// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing an upload (#186, design §6.2; #206, design §3).
 *
 * The Worker keeps nothing between requests, so the list of parts comes back
 * from whoever is uploading. It judges that list against the layout its own
 * token signed, has R2 assemble the object, and answers with three
 * measurements over what landed: the hash the ledger keys on, the size it
 * charges for, and the type a reader will be served.
 *
 * It reaches nothing to do that. The permission to finish this key is taken by
 * the caller before it asks, and the caller is what records the outcome — so
 * every refusal here is one the Worker can decide on its own, out of the
 * signature it verified and the bytes it can see.
 *
 * The hash is computed over the stored object rather than over what the
 * browser said. The ledger keys on it, and only bytes that actually landed
 * name what is actually there.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  signUploadTicket,
  type MediaLimits,
  type UploadTicketPayload,
} from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";
import { buildProbeAnswer, type ProbeRequest } from "@ingest/probe-answer.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

const PART_SIZE = 5 * 1024 * 1024;
const FINAL_PART_SIZE = 1024;

let seq = 0;

/** One part as the browser hands it back. */
interface HeldPart {
  partNumber: number;
  etag: string;
}

/**
 * Open an upload and send `partCount` of its parts.
 *
 * What comes back is everything the browser would be holding: the upload id,
 * the token for the next request, and the part list it has to send back to
 * finish. Nothing on the Worker's side remembers any of it.
 * @param partCount - How many parts to send.
 * @param over - Ticket fields to override.
 * @returns What the browser holds after those parts.
 */
async function uploadedThrough(
  partCount: number,
  over: Partial<UploadTicketPayload> = {},
): Promise<{
  storageKey: string;
  uploadId: string;
  token: string;
  parts: HeldPart[];
}> {
  const storageKey = `video/2026-09-05/${seq++}_done.mp4`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 2,
      partSize: PART_SIZE,
      contentType: "video/mp4",
      expiresAt: Date.now() + 300_000,
      sessionTokenTtlSeconds: 900,
      ...over,
    },
    env.INGEST_SHARED_SECRET,
  );
  let ctx = createExecutionContext();
  const opened = await worker.fetch(
    new Request("https://ingest.example.com/uploads", {
      method: "POST",
      headers: { "x-upload-ticket": ticket },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const session = await opened.json<{ uploadId: string; token: string }>();

  let token = session.token;
  const parts: HeldPart[] = [];
  const totalParts = over.totalParts ?? 2;
  for (let n = 1; n <= partCount; n += 1) {
    const isFinal = n === totalParts;
    ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(
        `https://ingest.example.com/uploads/${session.uploadId}/parts/${n}`,
        {
          method: "PUT",
          headers: { "x-upload-token": token },
          body: new Uint8Array(isFinal ? FINAL_PART_SIZE : PART_SIZE),
        },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const landed = await response.json<{
      token: string;
      partNumber: number;
      etag: string;
    }>();
    token = landed.token;
    parts.push({ partNumber: landed.partNumber, etag: landed.etag });
  }
  return { storageKey, uploadId: session.uploadId, token, parts };
}

/**
 * Ask the Worker to finish an upload, handing back the parts.
 * @param uploadId - The multipart upload.
 * @param token - The session token.
 * @param parts - The list the browser holds.
 * @param secret - The shared secret, or null to send none.
 * @param coverKey - Where a cut frame goes, when this upload asks for one.
 * @param run - The namespace a container run goes through, and the deadlines
 *   the request carries. Left out, the binding this suite declares is used —
 *   it has no image, so no run starts, which is what every case below but the
 *   container's own wants. The deadlines are separately optional, so a finish
 *   that could reach a container but names none can be told apart.
 * @returns The Worker's answer.
 */
async function complete(
  uploadId: string,
  token: string,
  parts: HeldPart[],
  secret: string | null = env.INGEST_SHARED_SECRET,
  coverKey?: string,
  run?: { limits?: MediaLimits; media: Env["MEDIA"] },
): Promise<Response> {
  const headers = new Headers({
    "x-upload-token": token,
    "content-type": "application/json",
  });
  if (secret !== null) headers.set("x-ingest-secret", secret);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${uploadId}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parts,
        ...(coverKey !== undefined && { coverKey }),
        ...(run?.limits !== undefined && { limits: run.limits }),
      }),
    }),
    run === undefined ? env : { ...env, MEDIA: run.media },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** SHA-256 of what is stored at `storageKey`, as lowercase hex. */
async function storedHash(storageKey: string): Promise<string> {
  const stored = await env.BUCKET.get(storageKey);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await stored!.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The permission that stops a replayed ticket used to be taken here, inside
// the Worker, before R2 was touched. It now belongs to whoever drives the
// finish, and a session token is something the browser holds — every part's
// answer hands it one. So the only thing separating "our server is finishing
// this" from "a page is finishing this behind our back" is a secret the
// browser never sees.
//
// What the browser could otherwise do is measured and written down in
// upload-grant.repo.ts: opening a second upload on a key already registered
// and completing it overwrites the object, while the ledger row still names
// the hash of the bytes that were there before.
describe("who may finish an upload", () => {
  it("refuses a caller who holds a valid token but no shared secret", async () => {
    const held = await uploadedThrough(2);

    const response = await complete(held.uploadId, held.token, held.parts, null);

    expect(response.status).toBe(401);
  });

  it("refuses a caller whose secret does not match", async () => {
    const held = await uploadedThrough(2);

    const response = await complete(
      held.uploadId,
      held.token,
      held.parts,
      "not-the-secret",
    );

    expect(response.status).toBe(401);
  });
});

describe("an upload whose parts all arrived", () => {
  it("makes the object readable at the key the ticket named", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    const stored = await env.BUCKET.get(storageKey);
    expect(stored?.size).toBe(PART_SIZE + FINAL_PART_SIZE);
  });

  it("keeps the content type the ticket signed", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);

    await complete(uploadId, token, parts);

    const stored = await env.BUCKET.head(storageKey);
    expect(stored?.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("answers with a hash of the stored bytes, not of what was claimed", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);

    const response = await complete(uploadId, token, parts);

    expect(await response.json()).toMatchObject({
      sha256: await storedHash(storageKey),
      sizeBytes: PART_SIZE + FINAL_PART_SIZE,
      contentType: "video/mp4",
    });
  });

  // Nothing here has a container to reach, which is on purpose (see the
  // binding in vitest.config.ts): what is exercised is the degraded case, and
  // the object standing through it is the point.
  it("stands when the media could not be read, with nothing measured", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sha256: await storedHash(storageKey),
      width: null,
      height: null,
      durationSeconds: null,
      cover: null,
    });
  });

  // Flat, like the other two endpoints, and holding only what this Worker
  // measured. Anything about the ledger row belongs to the caller that writes
  // it, and the Worker has no way to know it.
  it("answers with nothing beyond what it measured", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);

    const response = await complete(uploadId, token, parts);

    expect(Object.keys(await response.json<Record<string, unknown>>()).sort()).toEqual([
      "contentType",
      "cover",
      "durationSeconds",
      "height",
      "sha256",
      "sizeBytes",
      "width",
    ]);
  });
});

describe("an upload missing parts", () => {
  it("refuses and says what is owed, writing nothing", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(1);

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("1 of 2");
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });

  it("still finishes once the missing part is sent", async () => {
    // The refusal leaves the upload usable, which is what makes it a refusal
    // rather than an outcome.
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    await complete(uploadId, token, parts.slice(0, 1));

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    expect((await env.BUCKET.head(storageKey))?.size).toBe(
      PART_SIZE + FINAL_PART_SIZE,
    );
  });

  it("refuses a part the layout never signed", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const forged = [...parts, { partNumber: 3, etag: "made-up" }];

    const response = await complete(uploadId, token, forged);

    expect(response.status).toBe(400);
  });

  it("refuses a list that names one part twice", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    // Two entries, two parts expected — so counting alone says this list is
    // complete while part 2 was never sent at all.
    const duplicated = [parts[0]!, parts[0]!];

    const response = await complete(uploadId, token, duplicated);

    expect(response.status).toBe(400);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });
});

// A finish is replay-safe and does get re-delivered. The cover key is derived
// from the video's own, so the second delivery names the frame the first one
// already cut — and answering out of it is what keeps the container from
// running twice and keeps a second frame out of storage (A5).
describe("an upload whose cover already stands", () => {
  it("answers out of the standing frame, with what the first run measured", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_standing_cover.png`;
    const frame = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 5, 5]);
    await env.BUCKET.put(coverKey, frame, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { width: "1280", height: "720", durationSeconds: "6.5" },
    });

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      width: 1280,
      height: 720,
      durationSeconds: 6.5,
      cover: {
        storageKey: coverKey,
        sizeBytes: frame.byteLength,
        contentType: "image/png",
      },
    });
  });

  it("leaves the frame that stands exactly as it was", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_untouched_cover.png`;
    const frame = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    await env.BUCKET.put(coverKey, frame, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { width: "640", height: "360", durationSeconds: "3" },
    });

    await complete(uploadId, token, parts, env.INGEST_SHARED_SECRET, coverKey);

    const stored = await env.BUCKET.get(coverKey);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(frame);
  });
});

/** What a stand-in container was asked to do, and what it answered with. */
interface StandInRun {
  media: Env["MEDIA"];
  /** The key its outbound handler was authorised for. */
  authorisedFor: string | null;
  /** The request body it received, once it has received one. */
  asked: ProbeRequest | null;
}

/**
 * A namespace that answers one container run without a container.
 *
 * The binding this suite declares deliberately has no image behind it, so
 * every run against it refuses to start — which leaves the path a run that
 * succeeds takes untested, and it is the path that stores the frame and
 * reports the numbers. This stands in for the container alone: everything
 * between the finish request and it is the Worker's own code, and runs.
 * @param report - What the stand-in says ffprobe found.
 * @param cover - The frame it says ffmpeg cut, or null for none.
 * @returns The namespace to bind, and what it was asked.
 */
function containerAnswering(
  report: ProbeReport,
  cover: Uint8Array | null,
): StandInRun {
  const run: StandInRun = {
    authorisedFor: null,
    asked: null,
    media: {
      idFromName: (name: string) => name,
      get: () => ({
        setOutboundByHost: (
          _host: string,
          _handler: string,
          params: { key: string },
        ): Promise<void> => {
          run.authorisedFor = params.key;
          return Promise.resolve();
        },
        fetch: async (request: Request): Promise<Response> => {
          run.asked = await request.json<ProbeRequest>();
          return buildProbeAnswer(report, cover);
        },
      }),
    } as unknown as Env["MEDIA"],
  };
  return run;
}

const LIMITS: MediaLimits = { runDeadlineMs: 150_000, toolTimeoutMs: 60_000 };

/** One report of a 1920x1080 film, the shape ffprobe answers with. */
const FILM: ProbeReport = {
  durationSeconds: 12.25,
  streams: [
    {
      index: 0,
      codecType: "video",
      codecName: "h264",
      width: 1920,
      height: 1080,
      attachedPic: false,
    },
  ],
};

describe("an upload whose container answers", () => {
  it("stores the frame it cut and reports it beside the numbers", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_cut_cover.png`;
    const frame = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const run = containerAnswering(FILM, frame);

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
      { limits: LIMITS, media: run.media },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      width: 1920,
      height: 1080,
      durationSeconds: 12.25,
      cover: {
        storageKey: coverKey,
        sizeBytes: frame.byteLength,
        contentType: "image/png",
      },
    });
    const stored = await env.BUCKET.get(coverKey);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(frame);
  });

  // A re-delivery of this finish reads them back off the object. Nothing else
  // remembers them: the Worker keeps no state between requests, and the caller
  // may never have recorded the first answer.
  it("writes the measured numbers onto the frame it stored", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_numbered_cover.png`;
    const run = containerAnswering(FILM, new Uint8Array([0x89, 0x50]));

    await complete(uploadId, token, parts, env.INGEST_SHARED_SECRET, coverKey, {
      limits: LIMITS,
      media: run.media,
    });

    const stored = await env.BUCKET.head(coverKey);
    expect(stored?.customMetadata).toEqual({
      width: "1920",
      height: "1080",
      durationSeconds: "12.25",
    });
  });

  // A key absent reads back as no such number, which is what it is. Writing
  // one whose value is the word "null" would read back as a number nobody
  // measured.
  it("writes down only the numbers there were", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_undated_cover.png`;
    const run = containerAnswering(
      { ...FILM, durationSeconds: null },
      new Uint8Array([0x89, 0x50]),
    );

    await complete(uploadId, token, parts, env.INGEST_SHARED_SECRET, coverKey, {
      limits: LIMITS,
      media: run.media,
    });

    const stored = await env.BUCKET.head(coverKey);
    expect(stored?.customMetadata).toEqual({ width: "1920", height: "1080" });
  });

  // What keeps a video's bytes from reaching anything: the run is authorised
  // for the one key it is about, and the tool deadline it is held to is the
  // caller's, not one this Worker holds a second copy of.
  it("authorises the run for its own key alone, and passes the deadline on", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_asked_cover.png`;
    const run = containerAnswering(FILM, null);

    await complete(uploadId, token, parts, env.INGEST_SHARED_SECRET, coverKey, {
      limits: LIMITS,
      media: run.media,
    });

    expect(run.authorisedFor).toBe(storageKey);
    expect(run.asked).toMatchObject({
      wantCover: true,
      toolTimeoutMs: LIMITS.toolTimeoutMs,
    });
    expect(run.asked?.objectUrl).toContain(storageKey);
  });

  // The three numbers are the video's own; a cover is a separate asset with a
  // separate row, and no frame is one the caller never asked for.
  it("reports the numbers with no cover when the container cut none", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_nocut_cover.png`;
    const run = containerAnswering(FILM, null);

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
      { limits: LIMITS, media: run.media },
    );

    expect(await response.json()).toMatchObject({
      width: 1920,
      height: 1080,
      durationSeconds: 12.25,
      cover: null,
    });
    expect(await env.BUCKET.head(coverKey)).toBeNull();
  });

  // A finish with no deadlines is a caller that cannot be waited on, so no
  // run is started at all — even with a container standing by to answer. The
  // object still stands, hashed and reported.
  it("starts no run for a finish that names no deadline", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_undeadlined_cover.png`;
    const run = containerAnswering(FILM, new Uint8Array([0x89, 0x50]));

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
      { media: run.media },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      width: null,
      height: null,
      durationSeconds: null,
      cover: null,
    });
    expect(run.asked).toBeNull();
  });
});
