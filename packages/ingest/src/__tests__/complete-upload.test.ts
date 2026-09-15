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
import { NOTHING_FOUND, type ProbeReport } from "@ingest/media-metadata.js";
import { head, type Sample } from "./helpers/encoder-heads.js";
import { containerAnswering } from "./helpers/stand-in-container.js";

const PART_SIZE = 5 * 1024 * 1024;
const FINAL_PART_SIZE = 1024;

let seq = 0;

/** One part as the browser hands it back. */
interface HeldPart {
  partNumber: number;
  etag: string;
}

/**
 * One part's body: the given head, then zeroes out to `size`.
 * @param size - How large the part is.
 * @param leading - What it starts with, when it starts with anything.
 * @returns The bytes to send.
 */
function partBody(size: number, leading?: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(size);
  if (leading !== undefined) bytes.set(leading, 0);
  return bytes;
}

/**
 * Open an upload and send `partCount` of its parts.
 *
 * What comes back is everything the browser would be holding: the upload id,
 * the token for the next request, and the part list it has to send back to
 * finish. Nothing on the Worker's side remembers any of it.
 * @param partCount - How many parts to send.
 * @param over - Ticket fields to override.
 * @param opens - Which file the first part starts with. Left out, one of the
 *   kind the ticket declares, so a case not about the type gets an object
 *   whose bytes and ticket agree.
 * @returns What the browser holds after those parts.
 */
async function uploadedThrough(
  partCount: number,
  over: Partial<UploadTicketPayload> = {},
  opens?: Sample,
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
  const leading = head(opens ?? (over.contentType === "image/png" ? "png" : "mp4"));
  for (let n = 1; n <= partCount; n += 1) {
    const isFinal = n === totalParts;
    ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(
        `https://ingest.example.com/uploads/${session.uploadId}/parts/${n}`,
        {
          method: "PUT",
          headers: { "x-upload-token": token },
          body: partBody(
            isFinal ? FINAL_PART_SIZE : PART_SIZE,
            n === 1 ? leading : undefined,
          ),
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
 * @param run - What this finish gets instead of the bindings this suite
 *   declares, and the deadlines the request carries. Left out, the declared
 *   ones are used — the container binding has no image, so no run starts,
 *   which is what every case below but the container's own wants. The
 *   deadlines are separately optional, so a finish that could reach a
 *   container but names none can be told apart.
 * @returns The Worker's answer.
 */
async function complete(
  uploadId: string,
  token: string,
  parts: HeldPart[],
  secret: string | null = env.INGEST_SHARED_SECRET,
  coverKey?: string,
  run?: {
    limits?: MediaLimits;
    media?: Env["MEDIA"];
    bucket?: Env["BUCKET"];
  },
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
    {
      ...env,
      ...(run?.media !== undefined && { MEDIA: run.media }),
      ...(run?.bucket !== undefined && { BUCKET: run.bucket }),
    },
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

/**
 * A PNG header declaring `width` x `height`, which is all a cut frame is read
 * for.
 * @param width - What it declares.
 * @param height - What it declares.
 * @returns The bytes.
 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

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

  // The frame's own size is on the object because nothing else remembers it:
  // the Worker keeps no state between requests, and the caller may never have
  // recorded the first answer. A re-delivery reads it back rather than opening
  // the bytes again.
  it("reports the frame's own size out of what the first run wrote", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_sized_standing_cover.png`;
    await env.BUCKET.put(coverKey, pngHeader(1280, 720), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        width: "3840",
        height: "2160",
        coverWidth: "1280",
        coverHeight: "720",
      },
    });

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
    );

    expect(await response.json()).toMatchObject({
      width: 3840,
      height: 2160,
      cover: { width: 1280, height: 720 },
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

// Whether a medium has a frame worth showing is read off the type, and the
// lane that takes an address does not know the type until the transfer has
// happened — so it names a cover key on every call and this side decides.
// Narrowing only: the browser's lane asks for one on videos alone already.
describe("a cover asked for on something that has no frame", () => {
  it("is not asked of the container, which still measures the object", async () => {
    // The gate is on the frame, not on the run: an image has a resolution to
    // read, and this is the assertion that tells the two apart.
    const { uploadId, token, parts } = await uploadedThrough(2, {
      contentType: "image/png",
    });
    const coverKey = `image/2026-09-14/${seq++}_not_a_video_ask.png`;
    const run = containerAnswering(FILM, new Uint8Array([0x89, 0x50, 7, 7]));

    await complete(uploadId, token, parts, env.INGEST_SHARED_SECRET, coverKey, {
      limits: LIMITS,
      media: run.media,
    });

    expect(run.asked).toMatchObject({ wantCover: false });
  });

  it("is not cut, and nothing standing at that key is reported", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2, {
      contentType: "image/png",
    });
    const coverKey = `image/2026-09-14/${seq++}_not_a_video_cover.png`;
    await env.BUCKET.put(coverKey, new Uint8Array([0x89, 0x50, 4, 4]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { width: "100", height: "100" },
    });

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
    );

    expect(response.status).toBe(200);
    expect(await response.json<{ cover: unknown }>()).toMatchObject({
      cover: null,
    });
  });
});

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
  // may never have recorded the first answer. The type this upload was settled
  // as rides here for the same reason, and for one more: the bytes alone
  // cannot tell a song in an MP4 from a film in one.
  it("writes the measured numbers and the settled type onto the frame", async () => {
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
      sourceType: "video/mp4",
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
    expect(stored?.customMetadata).toEqual({
      width: "1920",
      height: "1080",
      sourceType: "video/mp4",
    });
  });

  // The frame's own size, which is not the video's: the cut is capped on the
  // way out of ffmpeg, so anything shot larger comes back smaller. The cover is
  // its own asset row and that row states these, so they travel in the answer
  // and go down on the object for a re-delivery to read.
  it("reports the frame's own size and writes it onto the frame", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const coverKey = `video/2026-09-05/${seq++}_sized_cover.png`;
    const run = containerAnswering(FILM, pngHeader(1280, 720));

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
      cover: { width: 1280, height: 720 },
    });
    const stored = await env.BUCKET.head(coverKey);
    expect(stored?.customMetadata).toMatchObject({
      coverWidth: "1280",
      coverHeight: "720",
    });
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

/**
 * The bucket this suite declares, with every ranged read refused.
 *
 * Only the head read takes a range, so this is the one call that fails —
 * assembling, hashing and the cover all go through untouched, which is what
 * makes the object below a stored, hashed object that nothing may unmake.
 * @returns A binding to hand one finish.
 */
function bucketRefusingRangedReads(): Env["BUCKET"] {
  return {
    get: (key: string, options?: R2GetOptions) =>
      options?.range === undefined
        ? env.BUCKET.get(key, options)
        : Promise.reject(new Error("no ranged reads")),
    head: (key: string) => env.BUCKET.head(key),
    put: (key: string, value: ReadableStream | ArrayBuffer | Uint8Array, options?: R2PutOptions) =>
      env.BUCKET.put(key, value, options),
    resumeMultipartUpload: (key: string, uploadId: string) =>
      env.BUCKET.resumeMultipartUpload(key, uploadId),
  } as unknown as Env["BUCKET"];
}

// What the ticket signed is a claim by whoever opened the upload — a browser
// reading the operating system's guess at an extension, or a task type's
// output decided before a byte moved. The bytes on R2 are the only thing that
// has been seen, and this is the one moment anybody sees them (#240).
describe("what the stored bytes are", () => {
  it("answers with what they are, not with what the ticket signed", async () => {
    const { uploadId, token, parts } = await uploadedThrough(
      2,
      { contentType: "audio/mpeg" },
      "mp4",
    );

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contentType: "video/mp4" });
  });

  // The route around every earlier gate: a `.svg` renamed `.png` is announced
  // as `image/png` by the operating system, so the picker takes it and the
  // ticket signs it. The bytes are markup with a script in them, and this is
  // the first and only place anybody looks at them (#190, #240).
  it("refuses markup that was announced as a picture", async () => {
    const { uploadId, token, parts } = await uploadedThrough(
      2,
      { contentType: "image/png" },
      "svg",
    );

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(415);
    expect(response.headers.get("x-ingest-failure")).toBe("unsupported_type");
  });

  it("refuses bytes that are no kind we store, naming why", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2, {}, "nothing");

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(415);
    expect(response.headers.get("x-ingest-failure")).toBe("unsupported_type");
  });

  // A 3D model is nothing the canvas file picker offers and nothing a model
  // can be handed, and it still reaches storage: our own `three_d` task writes
  // it through this upload. What lets it in is the ticket naming the same
  // format the bytes read as — a generator signs the type it wrote.
  it("takes a format only a generator produces when the ticket named it", async () => {
    const { uploadId, token, parts } = await uploadedThrough(
      2,
      { contentType: "model/gltf-binary" },
      "glb",
    );

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contentType: "model/gltf-binary",
    });
  });

  // The same bytes with a browser's ticket behind them. Nobody uploads a GLB,
  // so a picker claiming one is a picture is claiming something no lane can
  // produce, and it is refused like any other format we do not take.
  it("refuses that same format when the ticket claimed a picture", async () => {
    const { uploadId, token, parts } = await uploadedThrough(
      2,
      { contentType: "image/png" },
      "glb",
    );

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(415);
    expect(response.headers.get("x-ingest-failure")).toBe("unsupported_type");
  });

  // Refusing is an answer, not an undoing: the object was assembled and hashed
  // before anything here could judge it, and this Worker deletes nothing at
  // runtime. What becomes of an object nobody registered is the ledger's.
  it("leaves what landed where it landed when it refuses", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(
      2,
      {},
      "nothing",
    );

    await complete(uploadId, token, parts);

    expect((await env.BUCKET.head(storageKey))?.size).toBe(
      PART_SIZE + FINAL_PART_SIZE,
    );
  });

  // One format, more than one name: a reader, a browser and an operating
  // system all call an `audio/mp4` file `audio/x-m4a`. Which of them the
  // caller holds says nothing about the format, so the ledger records the
  // listed spelling rather than the one that happened to arrive.
  it("records the one name a format is listed under", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2, {}, "m4a");

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contentType: "audio/mp4" });
  });

  // A read that failed says nothing about the bytes. The object above it
  // stands, hashed and reported, so the finish carries on under the type the
  // ticket signed rather than turning a stored upload into a failed one.
  it("keeps the signed type when the head could not be read", async () => {
    // Signed as one thing and written as another, so the two answers this can
    // give are different values: a read that worked would name the bytes,
    // `video/mp4`, and only falling back names what the ticket carried.
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2, {
      contentType: "audio/mpeg",
    });

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      undefined,
      { bucket: bucketRefusingRangedReads() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contentType: "audio/mpeg",
      sha256: await storedHash(storageKey),
    });
  });
});

/** One report of a song: sound, and nothing to look at. */
const SOUND_ONLY: ProbeReport = {
  durationSeconds: 3.5,
  streams: [
    {
      index: 0,
      codecType: "audio",
      codecName: "aac",
      width: null,
      height: null,
      attachedPic: false,
    },
  ],
};

// A container says which container it is, not what is inside it. ffmpeg's
// default MP4 muxer writes the same brand for a film and for a piece of music,
// and WebM has no separate magic for sound either — so the bytes name both
// `video/…`, and only the probe report can say there is nothing to look at.
// Left uncorrected, a voiceover is registered as a video and lands on the
// canvas as a video node (#240, design §4.4).
describe("a container carrying only sound", () => {
  it.each([
    ["mp4AudioOnly", "audio/mp4"],
    ["webmAudioOnly", "audio/webm"],
  ] as const)("is registered as the audio it is (%s)", async (opens, expected) => {
    const { uploadId, token, parts } = await uploadedThrough(2, {}, opens);
    const run = containerAnswering(SOUND_ONLY, null);

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      undefined,
      { limits: LIMITS, media: run.media },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contentType: expected,
      durationSeconds: 3.5,
      width: null,
      height: null,
    });
  });

  it("leaves a film in the same container alone", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const run = containerAnswering(FILM, null);

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      undefined,
      { limits: LIMITS, media: run.media },
    );

    expect(await response.json()).toMatchObject({ contentType: "video/mp4" });
  });

  // Album art probes as a video stream 300x300, which is why the judgement is
  // on a stream that is not attached art rather than on there being one.
  it("is not fooled by the cover art a song carries", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2, {}, "mp4AudioOnly");
    const run = containerAnswering(
      {
        durationSeconds: 3.5,
        streams: [
          ...SOUND_ONLY.streams,
          {
            index: 1,
            codecType: "video",
            codecName: "mjpeg",
            width: 300,
            height: 300,
            attachedPic: true,
          },
        ],
      },
      null,
    );

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      undefined,
      { limits: LIMITS, media: run.media },
    );

    expect(await response.json()).toMatchObject({ contentType: "audio/mp4" });
  });

  // No report, no correction: what the bytes said stands. A container that
  // could not run says nothing about what is inside the file, and a probe is
  // best-effort by design — a video is a successful upload without one.
  it("keeps what the bytes said when no run was started", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2, {}, "mp4AudioOnly");

    const response = await complete(uploadId, token, parts);

    expect(await response.json()).toMatchObject({ contentType: "video/mp4" });
  });

  // A run that started and read nothing answers with an empty report, which is
  // also what a timeout and an unparsable output answer with. Reading that as
  // "no picture in it" would turn every unreadable video into audio.
  it("keeps what the bytes said when the run read nothing", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2, {}, "mp4AudioOnly");
    const run = containerAnswering(NOTHING_FOUND, null);

    const response = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      undefined,
      { limits: LIMITS, media: run.media },
    );

    expect(run.asked).not.toBeNull();
    expect(await response.json()).toMatchObject({ contentType: "video/mp4" });
  });
});

/** A song with cover art: sound, plus a picture that is not a picture of anything moving. */
const SOUND_WITH_ART: ProbeReport = {
  durationSeconds: 3.5,
  streams: [
    {
      index: 0,
      codecType: "audio",
      codecName: "aac",
      width: null,
      height: null,
      attachedPic: false,
    },
    {
      index: 1,
      codecType: "video",
      codecName: "mjpeg",
      width: 300,
      height: 300,
      attachedPic: true,
    },
  ],
};

// A finish is replay-safe and does get re-delivered, and the second delivery
// answers out of the frame the first one left rather than running the
// container again. What the first run learned about the type has to survive
// that, or the same upload is registered as a video the second time round.
describe("a re-delivered finish", () => {
  it("answers the type the first run settled on, without running again", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2, {}, "mp4AudioOnly");
    const coverKey = `audio/2026-09-15/${seq++}_art_cover.png`;
    // ffmpeg's cover call selects the best video stream and does not exclude
    // attached art, so a song carrying a picture does leave a frame here.
    const first = containerAnswering(SOUND_WITH_ART, pngHeader(300, 300));

    const opened = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
      { limits: LIMITS, media: first.media },
    );

    expect(await opened.json()).toMatchObject({ contentType: "audio/mp4" });

    // The same request again. A container standing by with a different answer
    // is what proves the re-delivery did not ask it.
    const second = containerAnswering(FILM, null);
    const replayed = await complete(
      uploadId,
      token,
      parts,
      env.INGEST_SHARED_SECRET,
      coverKey,
      { limits: LIMITS, media: second.media },
    );

    expect(second.asked).toBeNull();
    expect(await replayed.json()).toMatchObject({ contentType: "audio/mp4" });
  });
});
