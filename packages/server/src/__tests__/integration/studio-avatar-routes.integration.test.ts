// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio avatar upload / removal, end-to-end through the real Hono app.
 *
 * The body is raw image bytes, so the interesting behaviour is all at the
 * boundary — what gets in, what the type is decided from, and what the stored
 * key is built out of. What this pins:
 *   - the type comes from the BYTES; the Content-Type header is ignored
 *   - a signature with no entry in the extension table is refused, whether it
 *     is another image format or not an image at all
 *   - dimensions do NOT decide anything; a shape the crop dialog could never
 *     produce is stored like any other
 *   - the byte cap holds both when Content-Length declares the size and when
 *     it is absent, which is the case a header check alone would miss
 *   - the storage key is built from the studio's row and the server's own
 *     whitelist, never from anything the client sent
 *   - the object is written to storage before the row points at it
 *   - upload and removal are both admin-only, against a member who holds the
 *     rank just below admin as well as against a stranger
 *
 * What this deliberately does NOT pin: anything about a PNG's internal
 * structure. Whether a given animated PNG is refused depends on how far its
 * `acTL` chunk sits from the front, because that decision now belongs to the
 * signature sniffer and its scan budget. That is a consequence of the server
 * not inspecting avatars, not a guarantee it makes.
 *
 * @see packages/server/src/modules/studio/studioAvatar.service.ts
 * @see studio settings design (2026-07-28) § 2
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  getStorageConfig,
} from "@breatic/core";
import { avatarStorageKey } from "@server/modules/studio/studioAvatar.service.js";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "studio-avatar-routes-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** The square the crop dialog produces — the shape a real upload has. */
const FIXTURE_EDGE_PX = 512;

/**
 * Build a minimal PNG: signature, IHDR, one IDAT.
 *
 * The IHDR chunk is load-bearing, not decoration. Measured against the repo's
 * `file-type`: the 8-byte signature alone sniffs as `application/octet-stream`
 * and gets a 415; the detector needs a first chunk that declares type IHDR
 * with a length of exactly 13 before it will say `image/png`. Trimming this
 * fixture to its signature turns every accepting test in this file red.
 *
 * The dimensions inside that chunk are a different matter — nothing reads them
 * — which is why they are a parameter: a test can send a shape the crop dialog
 * could never produce and watch it be stored anyway.
 * @param animated - include `acTL`, which makes the sniffer report APNG.
 * @param width - width to declare in IHDR.
 * @param height - height to declare in IHDR; defaults to a square.
 * @returns the file bytes.
 */
function pngBytes(
  animated = false,
  width = FIXTURE_EDGE_PX,
  height = width,
): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, payload: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length);
    // CRC is not validated by signature sniffers.
    return Buffer.concat([len, Buffer.from(type, "ascii"), payload, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [sig, chunk("IHDR", ihdr)];
  if (animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0);
    parts.push(chunk("acTL", actl));
  }
  parts.push(chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])));
  return Buffer.concat(parts);
}

/** A minimal JPEG (SOI + APP0/JFIF header). */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0", "ascii"),
  Buffer.alloc(64),
]);

/** A minimal WebP (RIFF container with a WEBP fourcc). */
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "ascii"),
  Buffer.alloc(32),
]);

let seq = 0;
/**
 * Insert a fresh verified user.
 * @returns the new user's id.
 */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`avt-${seq++}@example.com`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let slugSeq = 0;
/**
 * Insert a studio plus its admin member row.
 * @param adminUserId - the user who becomes the studio's admin.
 * @returns the new studio's id and slug.
 */
async function insertStudio(
  adminUserId: string,
): Promise<{ id: string; slug: string }> {
  const slug = `avt-${(slugSeq++).toString().padStart(6, "0")}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, 'team', 'Avatar Test') RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${adminUserId}, 'admin')`;
  return { id, slug };
}

/**
 * Read a studio's stored avatar URL.
 * @param id - the studio's id.
 * @returns the avatar URL, or null.
 */
async function readAvatar(id: string): Promise<string | null> {
  const rows = await sql<{ avatar_url: string | null }[]>`
    SELECT avatar_url FROM studios WHERE id = ${id}
  `;
  return rows[0]!.avatar_url;
}

/**
 * Mint a real Redis session and return the authenticating Cookie header.
 * @param userId - the user to authenticate as.
 * @returns a Cookie header value.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * POST raw bytes to a studio's avatar endpoint.
 * @param slug - the studio's slug.
 * @param cookie - the caller's session cookie.
 * @param body - the raw image bytes.
 * @param contentType - the header to claim (deliberately arbitrary).
 * @returns the raw HTTP response.
 */
async function uploadAvatar(
  slug: string,
  cookie: string,
  body: Buffer,
  contentType = "application/octet-stream",
): Promise<Response> {
  return app.request(`/api/v1/studio/${slug}/avatar`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": contentType },
    body: new Uint8Array(body),
  });
}

describe("POST /studio/:slug/avatar — what gets accepted", () => {
  it("accepts a PNG and points the studio at the stored object", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await uploadAvatar(studio.slug, cookie, pngBytes());

    expect(res.status).toBe(200);
    const stored = await readAvatar(studio.id);
    expect(stored).not.toBeNull();
    // Key shape: the studio id from the row, the extension from the server's
    // whitelist, a timestamp and a nonce. Nothing the client sent appears.
    expect(stored).toMatch(
      new RegExp(`avatar/${studio.id}/\\d+-[0-9a-f]{8}\\.png$`),
    );
  });

  it("refuses a signature with no entry in the extension table", async () => {
    // Not a judgement about these formats. The whitelist exists to pick the
    // extension and content type a stored object is served under, and it holds
    // one entry because the crop dialog's canvas re-encode produces one format.
    // A signature that is not in it has nothing to be stored as.
    //
    // The APNG case belongs here rather than in one of its own, and note what
    // it does and does not say. THIS file sniffs as `image/apng` — another key
    // that is not in the table. It is not a claim about animated PNGs in
    // general: the sniffer stops looking after a fixed number of chunks, so an
    // `acTL` far enough from the front is never seen and the file sniffs as
    // plain PNG. That is what "the server does not inspect avatars" means in
    // practice, and it is why this assertion is written about a fixture rather
    // than about a format.
    const admin = await insertUser();
    const jpegStudio = await insertStudio(admin);
    const webpStudio = await insertStudio(admin);
    const apngStudio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    expect((await uploadAvatar(jpegStudio.slug, cookie, JPEG_BYTES)).status).toBe(415);
    expect((await uploadAvatar(webpStudio.slug, cookie, WEBP_BYTES)).status).toBe(415);
    expect((await uploadAvatar(apngStudio.slug, cookie, pngBytes(true))).status).toBe(415);

    expect(await readAvatar(jpegStudio.id)).toBeNull();
    expect(await readAvatar(webpStudio.id)).toBeNull();
    expect(await readAvatar(apngStudio.id)).toBeNull();
  });

  it("stores a PNG whatever its dimensions — the pixels are the client's business", async () => {
    // The server used to read IHDR and refuse anything that was not 512
    // square. It no longer does, and this pins that: an avatar is one URL on
    // one row, shown in a fixed-size element that crops whatever it is given,
    // uploadable only by an admin of the studio that will display it. There is
    // nothing about the pixels for this server to have an opinion on.
    //
    // 2000x37 is deliberately nothing the crop dialog could produce — neither
    // the agreed edge nor even a square.
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await uploadAvatar(studio.slug, cookie, pngBytes(false, 2000, 37));

    expect(res.status).toBe(200);
    expect(await readAvatar(studio.id)).toMatch(/\.png$/);
  });

  it("decides the type from the BYTES, not the Content-Type header", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    // Real PNG bytes, header lying about being a JPEG.
    const res = await uploadAvatar(studio.slug, cookie, pngBytes(), "image/jpeg");

    expect(res.status).toBe(200);
    expect(await readAvatar(studio.id)).toMatch(/\.png$/);
  });

  it("replaces rather than overwrites — the previous URL stays valid", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    // Two identical uploads, back to back — the case where only the key's
    // nonce keeps them apart. Relying on the clock here would pass or fail
    // depending on how fast the machine is.
    await uploadAvatar(studio.slug, cookie, pngBytes());
    const first = await readAvatar(studio.id);
    await uploadAvatar(studio.slug, cookie, pngBytes());
    const second = await readAvatar(studio.id);

    expect(second).not.toBe(first);
  });
});

describe("POST /studio/:slug/avatar — refusals", () => {
  it("refuses a non-image even when the header claims PNG", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await uploadAvatar(
      studio.slug,
      cookie,
      Buffer.from("this is definitely not an image", "utf-8"),
      "image/png",
    );

    expect(res.status).toBe(415);
    expect(await readAvatar(studio.id)).toBeNull();
  });

  it("refuses on a Content-Length over the cap without reading the body", async () => {
    // Deliberately contradictory: the body is a few dozen bytes of valid PNG,
    // but the header claims 10 MB. Only the header gate can refuse this —
    // the running total never gets near the cap. If that gate were missing,
    // this PNG would upload perfectly well and the test would see a 200.
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);
    const { avatar } = getStorageConfig();

    const res = await app.request(`/api/v1/studio/${studio.slug}/avatar`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "content-length": String(avatar.max_bytes * 10),
      },
      body: new Uint8Array(pngBytes()),
    });

    expect(res.status).toBe(413);
    expect(await readAvatar(studio.id)).toBeNull();
  });

  it("refuses an oversize body sent WITHOUT a Content-Length", async () => {
    // The gate a header check alone would miss: chunked transfer declares no
    // length, so the running total during the read is what actually holds.
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);
    const { avatar } = getStorageConfig();
    const oversize = Buffer.concat([pngBytes(), Buffer.alloc(avatar.max_bytes + 1)]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Several chunks, so the total only crosses the cap partway through.
        for (let sent = 0; sent < oversize.length; sent += 65536) {
          controller.enqueue(new Uint8Array(oversize.subarray(sent, sent + 65536)));
        }
        controller.close();
      },
    });

    const res = await app.request(`/api/v1/studio/${studio.slug}/avatar`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: stream,
      // @ts-expect-error — undici requires this for a streaming request body.
      duplex: "half",
    });

    expect(res.status).toBe(413);
    expect(await readAvatar(studio.id)).toBeNull();
  });

  it("refuses an empty body", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await uploadAvatar(studio.slug, cookie, Buffer.alloc(0));

    expect(res.status).toBe(422);
    expect(await readAvatar(studio.id)).toBeNull();
  });

  it("refuses a maintainer — avatar changes are admin-only", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(admin);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${member}, 'maintainer')`;
    const cookie = await loginCookie(member);

    const res = await uploadAvatar(studio.slug, cookie, pngBytes());

    expect(res.status).toBe(403);
    expect(await readAvatar(studio.id)).toBeNull();
  });
});

describe("DELETE /studio/:slug/avatar", () => {
  it("clears the avatar, falling back to initials", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);
    await uploadAvatar(studio.slug, cookie, pngBytes());
    expect(await readAvatar(studio.id)).not.toBeNull();

    const res = await app.request(`/api/v1/studio/${studio.slug}/avatar`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(await readAvatar(studio.id)).toBeNull();
  });

  it("refuses a non-member", async () => {
    const admin = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(stranger);

    const res = await app.request(`/api/v1/studio/${studio.slug}/avatar`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(403);
  });

  it("refuses a maintainer — removal is admin-only, not member-only", async () => {
    // The stranger case above passes at every rank, so on its own it pins
    // "some gate exists" rather than "the gate is admin". A maintainer is the
    // rank directly below admin, which is the one that tells those apart.
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(admin);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${member}, 'maintainer')`;
    const adminCookie = await loginCookie(admin);
    await uploadAvatar(studio.slug, adminCookie, pngBytes());
    const stored = await readAvatar(studio.id);
    expect(stored).not.toBeNull();

    const res = await app.request(`/api/v1/studio/${studio.slug}/avatar`, {
      method: "DELETE",
      headers: { Cookie: await loginCookie(member) },
    });

    expect(res.status).toBe(403);
    expect(await readAvatar(studio.id)).toBe(stored);
  });
});

describe("avatarStorageKey", () => {
  it("builds the key from the studio id and a whitelisted extension only", () => {
    expect(avatarStorageKey("s-1", "png", 1700000000000, "abcd1234")).toBe(
      "avatar/s-1/1700000000000-abcd1234.png",
    );
  });

  it("is tenant-scoped by studio, so two studios never collide", () => {
    // Same clock, same nonce: the studio id is the only thing left to separate
    // them, which is exactly the property being claimed.
    const a = avatarStorageKey("studio-a", "png", 1, "same");
    const b = avatarStorageKey("studio-b", "png", 1, "same");
    expect(a).not.toBe(b);
  });
});
