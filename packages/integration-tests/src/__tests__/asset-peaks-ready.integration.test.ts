// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * An audio row's peaks, once read, are announced to every live Project that references a live row stored under the
 * audio's storage key, in any studio (#1580, frames-split §7.20): the worker
 * publishes `asset-peaks:ready` with the audio's own address on each such Project's control channel, so a page waiting
 * for that waveform reads it once instead of on a timer. Only the peaks read itself is stubbed; the references, the
 * Projects and the control channel are real.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { Job } from "bullmq";
import type * as DomainModule from "@breatic/domain";

const readAudioPeaks = vi.hoisted(() => vi.fn());

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, audioPeaksService: { ...actual.audioPeaksService, readAudioPeaks } };
});

import {
  assetRepo,
  createPgClient,
  env,
  getStorageAdapter,
  getStreamRedis,
  initCore,
  loadLocales,
  projectControlChannelPattern,
  type Redis,
} from "@breatic/core";
import { AudioPeaksReadFailed, type AudioPeaksJob } from "@breatic/domain";
import { runAudioPeaks } from "@worker/handlers/audio-peaks.js";

let sql: ReturnType<typeof createPgClient>;
let subscriber: Redis;
const heard: { channel: string; message: Record<string, unknown> }[] = [];

beforeAll(async () => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "asset-peaks-ready-driver", max: 4, prepare: false });
  subscriber = getStreamRedis().duplicate();
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    heard.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
  });
  await subscriber.psubscribe(projectControlChannelPattern());
});

beforeEach(() => {
  readAudioPeaks.mockReset();
});

afterAll(async () => {
  await subscriber?.quit();
  await sql?.end({ timeout: 1 });
});

/** A user. */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, email_verified) values (${`peaks-${randomUUID()}@example.test`}, true) returning id
  `;
  return row!.id;
}

/** A team studio administered by `admin`. */
async function studio(admin: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into studios (created_by_user_id, slug, type, name) values (${admin}, ${`pk-${randomUUID().slice(0, 30)}`}, 'team', 'Peaks') returning id
  `;
  await sql`insert into studio_members (studio_id, user_id, role) values (${row!.id}, ${admin}, 'admin')`;
  return row!.id;
}

/** A Project in `studioId`, live unless archived or deleted. */
async function project(studioId: string, admin: string, state: "live" | "archived" | "deleted" = "live"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into projects (studio_id, created_by_user_id, slug, name, archived_at, archived_by_user_id, deleted_at)
    values (${studioId}, ${admin}, ${`pk-${randomUUID().slice(0, 30)}`}, 'Peaks',
      ${state === "archived" ? new Date() : null}, ${state === "archived" ? admin : null}, ${state === "deleted" ? new Date() : null})
    returning id
  `;
  return row!.id;
}

/** A registered audio row in `studioId`, under its own storage key unless one is given (a paste reuses the source's). */
async function audio(studioId: string, producer: string, sharedKey?: string): Promise<{ id: string; fileUrl: string; storageKey: string }> {
  const id = randomUUID();
  const storageKey = sharedKey ?? `test-media/${id}.mp3`;
  const fileUrl = (await getStorageAdapter()).publicUrl(storageKey);
  await sql`
    insert into studio_assets (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id, duration_seconds)
    values (${id}, ${studioId}, ${createHash("sha256").update(storageKey).digest("hex")}, ${storageKey}, ${fileUrl}, 4096, 'audio/mpeg', 'audio', 'upload', ${producer}, 3.5)
  `;
  return { id, fileUrl, storageKey };
}

/** `projectId` references `assetId`, live unless the reference was removed. */
async function reference(projectId: string, assetId: string, removed = false): Promise<void> {
  await sql`insert into project_asset_refs (project_id, asset_id, deleted_at) values (${projectId}, ${assetId}, ${removed ? new Date() : null})`;
}

/** An audio row referenced by two live Projects of one studio. */
async function sharedAudio(): Promise<{ asset: { id: string; fileUrl: string; storageKey: string }; p1: string; p2: string }> {
  const admin = await user();
  const s = await studio(admin);
  const asset = await audio(s, admin);
  const [p1, p2] = [await project(s, admin), await project(s, admin)];
  await reference(p1, asset.id);
  await reference(p2, asset.id);
  return { asset, p1, p2 };
}

/** One queued peaks read. */
function job(assetId: string): Job<AudioPeaksJob> {
  return { data: { assetId }, timestamp: Date.now() } as Job<AudioPeaksJob>;
}

/**
 * Every control message naming `assetId` on the given Projects' channels, read up to a sentinel published on each
 * after the run, so a message that was not sent is known not to be on its way.
 */
async function announced(assetId: string, projectIds: readonly string[]): Promise<{ projectId: string; message: Record<string, unknown> }[]> {
  const sentinels = projectIds.map((projectId) => ({ projectId, sentinel: randomUUID() }));
  for (const s of sentinels) {
    await getStreamRedis().publish(`${env.REDIS_KEY_PREFIX}:project:${s.projectId}:peaks-test-sentinel`, JSON.stringify({ sentinel: s.sentinel }));
  }
  const deadline = Date.now() + 5000;
  while (!sentinels.every((s) => heard.some((h) => h.message.sentinel === s.sentinel))) {
    if (Date.now() > deadline) throw new Error("a sentinel on the project control channel never arrived");
    await new Promise((r) => setTimeout(r, 10));
  }
  return heard.flatMap((h) => {
    if (h.message.assetId !== assetId) return [];
    const projectId = projectIds.find((id) => h.channel.startsWith(`${env.REDIS_KEY_PREFIX}:project:${id}:`));
    return projectId === undefined ? [] : [{ projectId, message: h.message }];
  });
}

describe("the Projects referencing an asset", () => {
  it("G-01 are the live Projects referencing any live row stored under it, in any studio (frames-split §7.20)", async () => {
    const admin = await user();
    const s = await studio(admin);
    const other = await studio(admin);
    const third = await studio(admin);
    const asset = await audio(s, admin);
    const pasted = await audio(other, admin, asset.storageKey);
    const gone = await audio(third, admin, asset.storageKey);
    await sql`update studio_assets set deleted_at = now() where id = ${gone.id}`;
    const p1 = await project(s, admin);
    const p2 = await project(s, admin, "archived");
    const q1 = await project(other, admin);
    const q2 = await project(other, admin);
    const r1 = await project(third, admin);
    const unrelated = await project(s, admin);
    await reference(p1, asset.id);
    await reference(p2, asset.id);
    await reference(q1, pasted.id);
    await reference(q2, pasted.id, true);
    await reference(r1, gone.id);
    await reference(unrelated, (await audio(s, admin)).id);
    expect([...(await assetRepo.listProjectsReferencingStorageKey(asset.storageKey))].sort()).toEqual([p1, q1].sort());
  });
});

describe("a peaks read that settled", () => {
  it.each(["generated", "existing"] as const)("G-02 announces %s peaks once to each live Project referencing the audio, with the audio's address", async (result) => {
    const { asset, p1, p2 } = await sharedAudio();
    readAudioPeaks.mockResolvedValue(result);
    await runAudioPeaks(job(asset.id));
    const got = await announced(asset.id, [p1, p2]);
    expect(got.map((g) => g.projectId).sort()).toEqual([p1, p2].sort());
    for (const g of got) expect(g.message).toMatchObject({ projectId: g.projectId, assetId: asset.id, url: asset.fileUrl });
  });

  it("G-06 announces to a Project in another studio whose pasted row shares the audio's storage key", async () => {
    const { asset, p1, p2 } = await sharedAudio();
    const admin = await user();
    const other = await studio(admin);
    const pasted = await audio(other, admin, asset.storageKey);
    const q1 = await project(other, admin);
    await reference(q1, pasted.id);
    readAudioPeaks.mockResolvedValue("generated");
    await runAudioPeaks(job(asset.id));
    const got = await announced(asset.id, [p1, p2, q1]);
    expect(got.map((g) => g.projectId).sort()).toEqual([p1, p2, q1].sort());
  });

  it.each(["gone", "none"] as const)("G-03 and G-04 announce nothing when the read came to %s", async (result) => {
    const { asset, p1, p2 } = await sharedAudio();
    readAudioPeaks.mockResolvedValue(result);
    await runAudioPeaks(job(asset.id));
    expect(await announced(asset.id, [p1, p2])).toEqual([]);
  });

  it("G-05 announces nothing when the read failed, and lets the queue try again", async () => {
    const { asset, p1, p2 } = await sharedAudio();
    readAudioPeaks.mockRejectedValue(new AudioPeaksReadFailed(asset.id));
    await expect(runAudioPeaks(job(asset.id))).rejects.toBeInstanceOf(AudioPeaksReadFailed);
    expect(await announced(asset.id, [p1, p2])).toEqual([]);
  });
});
