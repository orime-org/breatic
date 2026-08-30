// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The link from a video to the cover extracted for it — real-PG integration (#173).
 *
 * Until now the relationship existed only inside the one report that carried
 * both: the browser sent `cover_hash` alongside the video and the endpoint
 * resolved a cover URL from it on the spot. Nothing in the database recorded
 * which row was whose cover.
 *
 * Once the cover is produced server-side that stops working, and the path it
 * breaks on is dedup: a second upload of a video the studio already holds gets
 * the existing row back, and there is no cover_hash in that request to resolve
 * from. Without a stored link the node comes back showing a video that has a
 * cover, without it.
 *
 * These pin the two halves: the worker writes the link after registering the
 * cover, and a dedup hit reads a cover back through it.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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
import { initCore } from "@breatic/core";
import { assetRepo } from "@breatic/domain";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "asset-cover-link-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a user plus a team studio; returns both ids. */
async function insertStudio(): Promise<{ userId: string; studioId: string }> {
  const email = `cover-${seq++}@example.com`;
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const slug = `cover-s-${seq++}`;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${slug}, 'team', ${`S ${slug}`}) RETURNING id
  `;
  return { userId, studioId: studios[0]!.id };
}

/** Register one asset row directly, bypassing project-based attribution. */
async function registerAsset(
  studioId: string,
  userId: string,
  kind: "video" | "image",
): Promise<string> {
  const hash = crypto.randomBytes(32).toString("hex");
  const { asset } = await assetRepo.registerWithDedup({
    studioId,
    producedByUserId: userId,
    contentHash: hash,
    storageKey: `uploads/${crypto.randomUUID()}.${kind === "video" ? "mp4" : "png"}`,
    fileUrl: `https://cdn.example.com/${hash.slice(0, 8)}`,
    sizeBytes: 1024,
    mimeType: kind === "video" ? "video/mp4" : "image/png",
    kind,
    source: kind === "video" ? "upload" : "cover",
  });
  return asset.id;
}

describe("linking a video to its cover (#173)", () => {
  it("a freshly registered video has no cover yet", async () => {
    const { userId, studioId } = await insertStudio();
    const videoId = await registerAsset(studioId, userId, "video");

    expect(await assetRepo.findCoverOf(videoId)).toBeNull();
  });

  it("setCoverAsset makes the cover readable back from the video", async () => {
    const { userId, studioId } = await insertStudio();
    const videoId = await registerAsset(studioId, userId, "video");
    const coverId = await registerAsset(studioId, userId, "image");

    await assetRepo.setCoverAsset(videoId, coverId);

    const cover = await assetRepo.findCoverOf(videoId);
    expect(cover?.id).toBe(coverId);
    expect(cover?.kind).toBe("image");
  });

  // BullMQ replays the cover job whole (design §6.4.1), and the replay's
  // dedup hit resolves to the same cover row, so it writes the same id again.
  it("writing the same cover twice leaves the link unchanged", async () => {
    const { userId, studioId } = await insertStudio();
    const videoId = await registerAsset(studioId, userId, "video");
    const coverId = await registerAsset(studioId, userId, "image");

    await assetRepo.setCoverAsset(videoId, coverId);
    await assetRepo.setCoverAsset(videoId, coverId);

    expect((await assetRepo.findCoverOf(videoId))?.id).toBe(coverId);
  });

  it("the cover URL read back is the registered canonical, not the video's", async () => {
    const { userId, studioId } = await insertStudio();
    const videoId = await registerAsset(studioId, userId, "video");
    const coverId = await registerAsset(studioId, userId, "image");
    await assetRepo.setCoverAsset(videoId, coverId);

    const cover = await assetRepo.findCoverOf(videoId);
    const rows = await sql<{ storage_key: string; file_url: string }[]>`
      SELECT storage_key, file_url FROM studio_assets WHERE id = ${coverId}
    `;
    expect(cover?.storageKey).toBe(rows[0]!.storage_key);
    expect(cover?.fileUrl).toBe(rows[0]!.file_url);
  });

  it("a soft-deleted cover reads as no cover", async () => {
    const { userId, studioId } = await insertStudio();
    const videoId = await registerAsset(studioId, userId, "video");
    const coverId = await registerAsset(studioId, userId, "image");
    await assetRepo.setCoverAsset(videoId, coverId);

    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${coverId}`;

    expect(await assetRepo.findCoverOf(videoId)).toBeNull();
  });

  it("an id that names no asset reads as no cover", async () => {
    expect(await assetRepo.findCoverOf(crypto.randomUUID())).toBeNull();
  });
});
