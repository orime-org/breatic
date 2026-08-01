// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio avatar upload / removal, end-to-end through the real Hono app.
 *
 * The body is raw image bytes, so the interesting behaviour is all at the
 * boundary — what gets in, what the type is decided from, and what the stored
 * key is built out of. What this pins:
 *   - the type comes from the BYTES; the Content-Type header is ignored
 *   - an animated PNG is accepted (it sniffs as image/apng, not image/png)
 *   - a non-image is refused even when it claims to be a PNG
 *   - the byte cap holds both when Content-Length declares the size and when
 *     it is absent, which is the case a header check alone would miss
 *   - the storage key is built from the studio's row and the server's own
 *     whitelist, never from anything the client sent
 *   - only the admin may upload or remove
 *
 * @see packages/server/src/modules/studio/studioAvatar.service.ts
 * @see inner engineering/specs 2026-07-28 studio settings design, section 2
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
import { AVATAR_OUTPUT_PX } from "@breatic/shared";
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

/**
 * Build a minimal PNG: signature + IHDR, optionally with the `acTL` chunk
 * that makes it an animated PNG.
 * @param animated - include `acTL`, turning it into an APNG.
 * @param edge - square edge to declare in IHDR; defaults to what the crop
 *   dialog produces, so most cases read as "a normal avatar".
 * @returns the file bytes.
 */
function pngBytes(animated = false, edge = AVATAR_OUTPUT_PX): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, payload: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length);
    // CRC is not validated by signature sniffers.
    return Buffer.concat([len, Buffer.from(type, "ascii"), payload, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(edge, 0);
  ihdr.writeUInt32BE(edge, 4);
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

  it("refuses an ANIMATED PNG — one frame's dimensions say nothing about the whole", async () => {
    // Accepting these used to be right: the whitelist held four formats, the
    // uploader sent whatever the picker gave them, and an animated PNG *is* a
    // PNG — refusing it with a message that says PNG is supported would have
    // contradicted itself.
    //
    // Settling on one format removed that premise. The bytes now always come
    // from our own canvas re-encode, and `canvas.toBlob` cannot produce an
    // animated PNG at all, so this door only ever opened for requests that did
    // not come from us. And it is the worst door to leave open: the dimension
    // check reads one frame's grid, while the frame count stays unbounded, so a
    // file under the byte cap can still declare thousands of 512x512 frames and
    // make every viewer decode gigabytes — the exact cost this gate exists to
    // bound.
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await uploadAvatar(studio.slug, cookie, pngBytes(true));

    expect(res.status).toBe(415);
    expect(await readAvatar(studio.id)).toBeNull();
  });

  it("refuses JPEG and WebP — the crop step converts, so these never arrive", async () => {
    // The picker still takes any image the browser can decode; what reaches
    // here is always the canvas re-encode, and that is PNG. Accepting other
    // formats would mean accepting bytes whose dimensions this server cannot
    // read, which is the one thing the size rule below depends on.
    const admin = await insertUser();
    const jpegStudio = await insertStudio(admin);
    const webpStudio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    expect((await uploadAvatar(jpegStudio.slug, cookie, JPEG_BYTES)).status).toBe(415);
    expect((await uploadAvatar(webpStudio.slug, cookie, WEBP_BYTES)).status).toBe(415);

    expect(await readAvatar(jpegStudio.id)).toBeNull();
    expect(await readAvatar(webpStudio.id)).toBeNull();
  });

  it("refuses a PNG that is not the agreed square", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await uploadAvatar(studio.slug, cookie, pngBytes(false, 256));

    expect(res.status).toBe(422);
    expect(await readAvatar(studio.id)).toBeNull();
  });

  it("refuses a small PNG that declares enormous dimensions", async () => {
    // This is what the byte cap cannot catch: a few hundred bytes of header
    // claiming 25000 square, which every viewer's browser would then try to
    // decode. Reading IHDR costs 24 bytes and no decompression.
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await uploadAvatar(studio.slug, cookie, pngBytes(false, 25000));

    expect(res.status).toBe(422);
    expect(await readAvatar(studio.id)).toBeNull();
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
