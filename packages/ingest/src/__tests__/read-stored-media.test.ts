// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading an object already in storage (#299).
 *
 * A project cover or a studio avatar is finished without a media read, and our
 * worker asks for one afterwards. The object stands; this only answers what it
 * measures, through the same container run a finish uses.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { peaksKeyFor, previewKeyFor } from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import { containerAnswering } from "./helpers/stand-in-container.js";

/** When the job asking runs out. */
const DEADLINE_AT = Date.now() + 7_200_000;

/** What ffprobe answers for an 800x450 still picture. */
const PICTURE: ProbeReport = {
  durationSeconds: null,
  streams: [
    {
      index: 0,
      codecType: "video",
      codecName: "mjpeg",
      width: 800,
      height: 450,
      attachedPic: false,
    },
  ],
};

let seq = 0;

/**
 * Put an object in the bucket and name it.
 * @returns Its key.
 */
async function storedPicture(): Promise<string> {
  const key = `image/2026-10-01/${seq++}_cover.jpg`;
  await env.BUCKET.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
    httpMetadata: { contentType: "image/jpeg" },
  });
  return key;
}

/**
 * Ask the Worker to read one object.
 * @param body - What the request carries.
 * @param secret - The shared secret, or null to send none.
 * @param media - The container binding this request gets.
 * @returns The Worker's answer.
 */
async function read(
  body: unknown,
  secret: string | null = env.INGEST_SHARED_SECRET,
  media?: Env["MEDIA"],
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("x-ingest-secret", secret);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/media", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { ...env, ...(media !== undefined && { MEDIA: media }) },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("who may ask for a read", () => {
  // Every run costs a container start, and the key it names may be any key in
  // the bucket. Only our own backend holds the secret.
  it("refuses a caller with no shared secret", async () => {
    const storageKey = await storedPicture();

    const response = await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT },
      null,
    );

    expect(response.status).toBe(401);
  });

  it("refuses a caller whose secret does not match", async () => {
    const storageKey = await storedPicture();

    const response = await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT },
      "not-the-secret",
    );

    expect(response.status).toBe(401);
  });
});

describe("what a read needs", () => {
  it.each([
    ["no key", { contentType: "image/jpeg", deadlineAt: DEADLINE_AT }],
    ["no type", { storageKey: "image/x.jpg", deadlineAt: DEADLINE_AT }],
    ["no deadline", { storageKey: "image/x.jpg", contentType: "image/jpeg" }],
    [
      "a deadline that is not positive",
      {
        storageKey: "image/x.jpg",
        contentType: "image/jpeg",
        deadlineAt: 0,
      },
    ],
  ])("refuses a request with %s", async (_case, body) => {
    const response = await read(body);

    expect(response.status).toBe(400);
  });

  it("answers 404 for a key with no object", async () => {
    const run = containerAnswering(PICTURE, null);

    const response = await read(
      {
        storageKey: "image/2026-10-01/missing.jpg",
        contentType: "image/jpeg",
        deadlineAt: DEADLINE_AT,
      },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(response.status).toBe(404);
    expect(run.asked).toBeNull();
  });
});

describe("a read of a stored object", () => {
  it("answers what the container measured", async () => {
    const storageKey = await storedPicture();
    const run = containerAnswering(PICTURE, null);

    const response = await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      width: 800,
      height: 450,
      durationSeconds: null,
    });
  });

  // The run is authorised for the one key it reads, asks for no frame, and is
  // held to the caller's deadline rather than one this Worker keeps.
  it("asks the container about that key alone, for numbers only", async () => {
    const storageKey = await storedPicture();
    const run = containerAnswering(PICTURE, null);

    await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(run.authorisedFor).toBe(storageKey);
    expect(run.asked).toMatchObject({
      wantCover: false,
      deadlineAt: DEADLINE_AT,
    });
  });

  // A container that cannot answer leaves the numbers unknown, which is what
  // a finish records in the same case. The caller writes nothing back.
  it("answers no numbers when there is no container to run", async () => {
    const storageKey = await storedPicture();

    const response = await read({
      storageKey,
      contentType: "image/jpeg",
      deadlineAt: DEADLINE_AT,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      width: null,
      height: null,
      durationSeconds: null,
    });
  });
});

// The deferred read of a project cover or avatar, and the backfill of objects
// stored before previews existed, both ask for a preview here (inner#1320). The
// answer says which of four things happened, so a run that could not start is
// told apart from one that ran and had nothing to cut.
describe("a read that asks for a preview", () => {
  const PREVIEW_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);

  it("cuts and stores one when none stands", async () => {
    const storageKey = await storedPicture();
    const run = containerAnswering(PICTURE, null, PREVIEW_BYTES);

    const response = await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT, wantPreview: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toEqual({
      width: 800,
      height: 450,
      durationSeconds: null,
      preview: "generated",
    });
    const stored = await env.BUCKET.get(previewKeyFor(storageKey));
    expect(stored?.httpMetadata?.contentType).toBe("image/webp");
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PREVIEW_BYTES);
  });

  it("leaves a standing preview alone and still measures", async () => {
    const storageKey = await storedPicture();
    await env.BUCKET.put(previewKeyFor(storageKey), new Uint8Array([7]), {
      httpMetadata: { contentType: "image/webp" },
    });
    const run = containerAnswering(PICTURE, null, PREVIEW_BYTES);

    const response = await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT, wantPreview: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toMatchObject({ width: 800, preview: "existing" });
    expect(run.asked).toMatchObject({ wantPreview: false });
    const stored = await env.BUCKET.get(previewKeyFor(storageKey));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array([7]));
  });

  // The picture had a frame to cut from, so a run with no preview is one that
  // ran out of time or failed: the backfill lists it to run again.
  it("answers failed when a picture with a frame came back with no preview", async () => {
    const storageKey = await storedPicture();
    const run = containerAnswering(PICTURE, null, null);

    const response = await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT, wantPreview: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toMatchObject({ preview: "failed" });
    expect(await env.BUCKET.head(previewKeyFor(storageKey))).toBeNull();
  });

  // An animated WebP probes 0x0 and by design gets no preview.
  it("answers none for a picture with no frame to cut from", async () => {
    const storageKey = await storedPicture();
    const animated: ProbeReport = {
      ...PICTURE,
      streams: [{ ...PICTURE.streams[0]!, codecName: "webp", width: 0, height: 0 }],
    };
    const run = containerAnswering(animated, null, null);

    const response = await read(
      { storageKey, contentType: "image/webp", deadlineAt: DEADLINE_AT, wantPreview: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toMatchObject({ preview: "none" });
  });

  it("answers failed when no container ran", async () => {
    const storageKey = await storedPicture();

    const response = await read({
      storageKey,
      contentType: "image/jpeg",
      deadlineAt: DEADLINE_AT,
      wantPreview: true,
    });

    expect(await response.json()).toMatchObject({ preview: "failed" });
  });
});

// The audio-peaks job and the peaks backfill ask for peaks here (inner#1305
// §4.4). The answer has the preview's four outcomes, so the job can retry a run
// that came back without them.
describe("a read that asks for peaks", () => {
  const PEAKS_BYTES = new TextEncoder().encode('{"version":1,"peaks":[0,128,255]}');
  const SONG: ProbeReport = {
    durationSeconds: 61,
    streams: [{ index: 0, codecType: "audio", codecName: "mp3", width: null, height: null, attachedPic: false }],
  };

  /**
   * Put an audio object in the bucket and name it.
   * @returns Its key.
   */
  async function storedSong(): Promise<string> {
    const key = `audio/2026-10-21/${seq++}_song.mp3`;
    await env.BUCKET.put(key, new Uint8Array([0x49, 0x44, 0x33]), {
      httpMetadata: { contentType: "audio/mpeg" },
    });
    return key;
  }

  it("reads and stores them when none stand", async () => {
    const storageKey = await storedSong();
    const run = containerAnswering(SONG, null, null, PEAKS_BYTES);

    const response = await read(
      { storageKey, contentType: "audio/mpeg", deadlineAt: DEADLINE_AT, wantPeaks: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toEqual({
      width: null,
      height: null,
      durationSeconds: 61,
      peaks: "generated",
    });
    expect(run.asked).toMatchObject({ wantPeaks: true, wantPreview: false });
    const stored = await env.BUCKET.get(peaksKeyFor(storageKey));
    expect(stored?.httpMetadata?.contentType).toBe("application/json");
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PEAKS_BYTES);
  });

  it("leaves standing peaks alone and still measures", async () => {
    const storageKey = await storedSong();
    await env.BUCKET.put(peaksKeyFor(storageKey), new Uint8Array([7]));
    const run = containerAnswering(SONG, null, null, PEAKS_BYTES);

    const response = await read(
      { storageKey, contentType: "audio/mpeg", deadlineAt: DEADLINE_AT, wantPeaks: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toMatchObject({ durationSeconds: 61, peaks: "existing" });
    expect(run.asked).toMatchObject({ wantPeaks: false });
    const stored = await env.BUCKET.get(peaksKeyFor(storageKey));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array([7]));
  });

  it("answers failed when audio with a length came back with no peaks", async () => {
    const storageKey = await storedSong();
    const run = containerAnswering(SONG, null, null, null);

    const response = await read(
      { storageKey, contentType: "audio/mpeg", deadlineAt: DEADLINE_AT, wantPeaks: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toMatchObject({ peaks: "failed" });
    expect(await env.BUCKET.head(peaksKeyFor(storageKey))).toBeNull();
  });

  it("answers none for an object with no sound to read", async () => {
    const storageKey = await storedPicture();
    const run = containerAnswering(PICTURE, null, null, PEAKS_BYTES);

    const response = await read(
      { storageKey, contentType: "image/jpeg", deadlineAt: DEADLINE_AT, wantPeaks: true },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).toMatchObject({ peaks: "none" });
    expect(await env.BUCKET.head(peaksKeyFor(storageKey))).toBeNull();
  });

  it("answers failed when no container ran", async () => {
    const storageKey = await storedSong();

    const response = await read({
      storageKey,
      contentType: "audio/mpeg",
      deadlineAt: DEADLINE_AT,
      wantPeaks: true,
    });

    expect(await response.json()).toMatchObject({ peaks: "failed" });
  });

  it("answers no peaks outcome when none were asked for", async () => {
    const storageKey = await storedSong();
    const run = containerAnswering(SONG, null, null, PEAKS_BYTES);

    const response = await read(
      { storageKey, contentType: "audio/mpeg", deadlineAt: DEADLINE_AT },
      env.INGEST_SHARED_SECRET,
      run.media,
    );

    expect(await response.json()).not.toHaveProperty("peaks");
    expect(await env.BUCKET.head(peaksKeyFor(storageKey))).toBeNull();
  });
});
