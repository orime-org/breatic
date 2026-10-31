// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Transfer files at the ingest Worker (inner#1006 §4.8): a transfer ticket
 * takes only bytes that start with the transfer signature, and every other
 * ticket refuses them. Cases G01–G05 of the test spec.
 *
 * The finish is sent the way our server sends a transfer's: with the shared
 * secret, `deferMediaRead: true` and the limits. A stand-in media container
 * records whether it was asked anything at all, so `run.asked === null` means
 * no container was started (no upright turn, no media read).
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { INGEST_FAILURE_HEADER, signUploadTicket, uprightKeyFor } from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";
import { writeUpright } from "@ingest/media-container.js";
import { buildProbeAnswer, type ProbeRequest } from "@ingest/probe-answer.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import { UPRIGHT_OBJECT_HOST, type UprightOutcome } from "@ingest/upright-run.js";
import { openForTest } from "./helpers/open-upload.js";

/** `TRANSFER_MEDIA_TYPE`, pinned to the shared export by TF01. */
const TMT = "application/vnd.breatic.transfer";

/** `TRANSFER_SIGNATURE`, pinned to the shared export by TF01. */
const SIGNATURE = "BREATIC-TRANSFER/1\n";

const DEADLINE_AT = Date.now() + 7_200_000;
const LIMITS = { uprightJpegQuality: 90, uprightMaxBytes: 64 * 1024 * 1024 };

let seq = 0;

/**
 * `encodeTransferBody(JSON.stringify(v))`, written out from the format's
 * definition: the signature line, then the JSON's UTF-8 bytes.
 * @param v - The request body.
 * @returns The transfer file's bytes.
 */
function enc(v: unknown): Uint8Array {
  return new TextEncoder().encode(SIGNATURE + JSON.stringify(v));
}

/**
 * A JPEG whose APP1 Exif segment says `orientation` (same as
 * upright-finish.test.ts `jpeg`).
 * @param orientation - The EXIF orientation, 1–8.
 * @returns The file's bytes.
 */
function jpeg(orientation: number): Uint8Array {
  const tiff = new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const exif = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
  const length = exif.length + 2;
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...exif,
    0xff, 0xda, 0x00, 0x02, ...new Uint8Array(200).fill(7), 0xff, 0xd9,
  ]);
}

/** A portrait picture, the shape ffprobe answers with. */
const PORTRAIT: ProbeReport = {
  durationSeconds: null,
  streams: [
    { index: 0, codecType: "video", codecName: "mjpeg", width: 3000, height: 4000, attachedPic: false },
  ],
};

/** What a stand-in container was asked, and the namespace to pass in. */
interface UprightRun {
  media: Env["MEDIA"];
  asked: ProbeRequest | null;
  writeGrant: { key: string; contentType: string; maxBytes: number } | null;
}

/**
 * Stand a container in for one run (same as upright-finish.test.ts
 * `uprightContainer`): it records what it was asked and turns the picture
 * through the real write-back handler.
 * @param turned - The upright bytes.
 * @returns The namespace and what it was asked.
 */
function uprightContainer(turned: Uint8Array): UprightRun {
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
        if (asked.upright === undefined) return buildProbeAnswer(PORTRAIT, null, null);
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
        return buildProbeAnswer(PORTRAIT, null, null, outcome);
      },
    }),
  } as unknown as Env["MEDIA"];
  return run;
}

/** What the browser holds once its one part has landed. */
interface Held {
  storageKey: string;
  uploadId: string;
  token: string;
  parts: { partNumber: number; etag: string }[];
}

/**
 * Upload `bytes` as one part under a ticket signed for `contentType`.
 * @param bytes - The object's bytes.
 * @param contentType - The type the ticket signs.
 * @param storageKey - The key the ticket names.
 * @returns What the browser holds.
 */
async function uploaded(bytes: Uint8Array, contentType: string, storageKey: string): Promise<Held> {
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 1,
      partSize: 5 * 1024 * 1024,
      contentType,
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

/**
 * A transfer key, as `storageKey({ taskType: "transfer", ext: ".transfer" })` mints one.
 * @returns A fresh key.
 */
function transferKey(): string {
  return `transfer/2026-10-24/${seq++}_00000000-0000-4000-8000-00000000000${seq % 10}.transfer`;
}

/**
 * Ask the Worker to finish, the way our server finishes a transfer.
 * @param held - What the browser holds.
 * @param media - The stand-in container namespace.
 * @returns The Worker's answer.
 */
async function finish(held: Held, media: Env["MEDIA"]): Promise<Response> {
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
        coverKey: held.storageKey.replace(/\.[^./]+$/, "_cover.png"),
        deadlineAt: DEADLINE_AT,
        limits: LIMITS,
        deferMediaRead: true,
      }),
    }),
    { ...env, MEDIA: media },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("G01 a transfer ticket takes a signed file whose body starts with <svg", () => {
  it("answers 200 as the transfer type, starts no container and stores the bytes unchanged", async () => {
    const bytes = enc({ text: "<svg onload=1>" + "x".repeat(4096) });
    const held = await uploaded(bytes, TMT, transferKey());
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, run.media);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contentType: TMT, sizeBytes: bytes.byteLength });
    expect(run.asked).toBeNull();
    const stored = await env.BUCKET.get(held.storageKey);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });
});

describe("G02 a media ticket refuses the same signed file", () => {
  it("answers 415 unsupported_type", async () => {
    const bytes = enc({ text: "<svg onload=1>" + "x".repeat(4096) });
    const held = await uploaded(bytes, "image/png", `image/2026-10-24/${seq++}_x.png`);
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, run.media);

    expect(response.status).toBe(415);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("unsupported_type");
  });
});

describe("G03 a transfer ticket refuses an EXIF-oriented JPEG before turning it", () => {
  it("answers 415 unsupported_type, starts no container and writes no upright copy", async () => {
    const held = await uploaded(jpeg(6), TMT, transferKey());
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, run.media);

    expect(response.status).toBe(415);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("unsupported_type");
    expect(run.asked).toBeNull();
    expect(await env.BUCKET.head(uprightKeyFor(held.storageKey))).toBeNull();
  });
});

describe("G04 a transfer ticket refuses JSON without the signature", () => {
  it("answers 415 unsupported_type", async () => {
    const held = await uploaded(new TextEncoder().encode(JSON.stringify({ a: 1 })), TMT, transferKey());
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, run.media);

    expect(response.status).toBe(415);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("unsupported_type");
  });
});

describe("G05 a transfer ticket refuses a version-2 signature", () => {
  it("answers 415 unsupported_type", async () => {
    const held = await uploaded(new TextEncoder().encode("BREATIC-TRANSFER/2\n{}"), TMT, transferKey());
    const run = uprightContainer(jpeg(1));

    const response = await finish(held, run.media);

    expect(response.status).toBe(415);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("unsupported_type");
  });
});
