// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How uploads and fetched addresses are counted, through the real routes,
 * with real Postgres and Redis and payments on (inner#1968, test spec area B:
 * B-13 to B-23, B-38, B-41 to B-44, B-67 to B-71, B-77).
 *
 * Each file, and each address, is one operation keyed by the operation id the
 * browser sends as the request's `Idempotency-Key`: `upload:<actor>:<id>` and
 * `url:<actor>:<id>`. A miss is counted when its grant is consumed (the ingest
 * Worker's report); a dedup hit is counted once every write of the hit branch
 * has succeeded. A derived image (`derived: true`, a Space, no node, purpose
 * or source, registered as an image) is deferred instead. Only the ingest
 * Worker's open is replaced (`ingest-open-double`); the report is applied the
 * way the report route applies it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

/** Failures a case injects into the dedup-hit branch. */
const inject1968 = vi.hoisted(() => ({ settleDedupHit: false, openDone: false }));

vi.mock("@server/modules/asset/assetUpload.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AssetUploadModule>();
  return {
    ...actual,
    settleDedupHit: async (...args: Parameters<typeof actual.settleDedupHit>) => {
      if (inject1968.settleDedupHit) throw new Error("injected settleDedupHit failure");
      return actual.settleDedupHit(...args);
    },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    sceneTaskService: {
      ...actual.sceneTaskService,
      openDone: async (...args: Parameters<typeof actual.sceneTaskService.openDone>) => {
        if (inject1968.openDone) throw new Error("injected openDone failure");
        return actual.sceneTaskService.openDone(...args);
      },
    },
  };
});

import type * as AssetUploadModule from "@server/modules/asset/assetUpload.service.js";
import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { getRedis, initCore, loadLocales } from "@breatic/core";
import { resetOpenDouble, setOpenMode } from "../helpers/ingest-open-double.js";
import {
  PAYMENTS_ON,
  captureLogs,
  ledgerRow,
  ledgerRows,
  request,
  seedAccount,
  seedAsset,
  stored,
  ticket,
  used,
  type Account,
} from "./operation-counting-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "operation-upload-counting-test" } });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

beforeEach(() => {
  resetOpenDouble();
  inject1968.settleDedupHit = false;
  inject1968.openDone = false;
});

/**
 * Upload one file end to end: ticket, then the Worker's report.
 * @param a - The account.
 * @param file - What differs from a fresh PNG.
 * @param reportedAs - The type the Worker reads the bytes as.
 * @returns The ledger key and the registered asset id.
 */
async function upload(a: Account, file: Record<string, unknown> = {}, reportedAs = "image/png"): Promise<{ key: string; assetId: string }> {
  const t = await ticket(app, a, file);
  expect(t.res.status, await t.res.clone().text()).toBe(201);
  await stored(t.storageKey!, reportedAs);
  const [asset] = await sql<{ id: string }[]>`select id from studio_assets where storage_key = ${t.storageKey!}`;
  return { key: t.key, assetId: asset!.id };
}

/**
 * Grants written for the account.
 * @param a - The account.
 * @returns Each grant's operation key.
 */
async function grants(a: Account): Promise<Array<{ operation_key: string | null }>> {
  return sql<{ operation_key: string | null }[]>`select operation_key from upload_grants where user_id = ${a.userId} order by created_at`;
}

/**
 * Forget every run-once answer the account's requests left, as a day passing would.
 * @param a - The account.
 */
async function forgetRunOnce(a: Account): Promise<void> {
  const keys = await getRedis().keys(`*:server:idempotency:${a.userId}:*`);
  if (keys.length > 0) await getRedis().del(...keys);
}

describe("B.1 each upload is one operation", () => {
  it("B-13 ten files in one press are ten operations, each counted with the asset it registered", async () => {
    const a = await seedAccount(sql);
    const uploads = [];
    for (let i = 0; i < 10; i++) uploads.push(await upload(a));
    for (const u of uploads) {
      expect(await ledgerRow(sql, u.key)).toMatchObject({ kind: "upload", status: "counted", asset_id: u.assetId, actor_user_id: a.userId, studio_id: a.studioId, project_id: a.projectId });
    }
    expect(await used(a)).toBe(10);
  });

  it("B-14 a dedup hit counts once, under the asset it hit", async () => {
    const a = await seedAccount(sql);
    const asset = await seedAsset(sql, a.studioId, a.userId);
    const t = await ticket(app, a, { client_hash: asset.hash });
    expect(t.res.status).toBe(200);
    expect(await ledgerRow(sql, t.key)).toMatchObject({ kind: "upload", status: "counted", asset_id: asset.id });
    expect(await used(a)).toBe(1);
  });

  it("B-15 a dedup hit whose settle fails is released and does not count", async () => {
    const a = await seedAccount(sql);
    const asset = await seedAsset(sql, a.studioId, a.userId);
    inject1968.settleDedupHit = true;
    const t = await ticket(app, a, { client_hash: asset.hash });
    expect(t.res.status).toBeGreaterThanOrEqual(500);
    expect((await ledgerRow(sql, t.key))?.status).toBe("released");
    expect(await used(a)).toBe(0);
  });

  it("B-16 a 3D model import counts once on a miss and once on a hit, is never deferred, and its grant stays derived", async () => {
    const a = await seedAccount(sql);
    const scene = { purpose: "scene_model", space_id: a.spaceId, label: "Lamp", filename: "lamp.glb", content_type: "model/gltf-binary" };
    const miss = await upload(a, scene, "model/gltf-binary");
    const [grant] = await sql<{ derived: boolean }[]>`select derived from upload_grants where operation_key = ${miss.key}`;
    expect(grant?.derived).toBe(true);
    const model = await seedAsset(sql, a.studioId, a.userId, "model");
    const hit = await ticket(app, a, { ...scene, client_hash: model.hash });
    expect(hit.res.status).toBe(200);
    for (const key of [miss.key, hit.key]) expect((await ledgerRow(sql, key))?.status).toBe("counted");
    expect(await used(a)).toBe(2);
  });

  it("B-17 a 3D model hit whose task row cannot open is released", async () => {
    const a = await seedAccount(sql);
    const model = await seedAsset(sql, a.studioId, a.userId, "model");
    inject1968.openDone = true;
    const hit = await ticket(app, a, { purpose: "scene_model", space_id: a.spaceId, label: "Lamp", filename: "lamp.glb", content_type: "model/gltf-binary", client_hash: model.hash });
    expect(hit.res.status).toBeGreaterThanOrEqual(500);
    expect((await ledgerRow(sql, hit.key))?.status).toBe("released");
    expect(await used(a)).toBe(0);
  });

  it("B-18 a project cover counts once in its project", async () => {
    const a = await seedAccount(sql);
    const cover = await upload(a, { purpose: "project_cover" });
    expect(await ledgerRow(sql, cover.key)).toMatchObject({ status: "counted", project_id: a.projectId });
    expect(await used(a)).toBe(1);
  });

  it("B-19 a studio avatar counts on a miss and on a hit, with no project", async () => {
    const a = await seedAccount(sql);
    const avatar = { project_id: undefined, studio_id: a.studioId, purpose: "studio_avatar" };
    const miss = await upload(a, avatar);
    const existing = await seedAsset(sql, a.studioId, a.userId);
    const hit = await ticket(app, a, { ...avatar, client_hash: existing.hash });
    expect(hit.res.status).toBe(200);
    for (const key of [miss.key, hit.key]) {
      expect(await ledgerRow(sql, key)).toMatchObject({ kind: "upload", status: "counted", project_id: null, studio_id: a.studioId });
    }
    expect(await used(a)).toBe(2);
  });

  it("B-20 a browser mini-tool's single export counts as one upload", async () => {
    const a = await seedAccount(sql);
    const exported = await upload(a, { source: "mini_tool", tool_name: "image.crop", space_id: a.spaceId, node_id: crypto.randomUUID() });
    expect(await ledgerRow(sql, exported.key)).toMatchObject({ kind: "upload", status: "counted" });
    expect(await used(a)).toBe(1);
  });

  it("B-23 three local files pasted into a Document are three operations", async () => {
    const a = await seedAccount(sql);
    for (let i = 0; i < 3; i++) await upload(a, { space_id: a.spaceId });
    expect((await ledgerRows(sql, a)).filter((r) => r.kind === "upload" && r.status === "counted")).toHaveLength(3);
    expect(await used(a)).toBe(3);
  });
});

describe("B.1 each fetched address is one operation", () => {
  /**
   * Fetch addresses and have the Worker store each.
   * @param a - The account.
   * @param lane - The canvas or the Document entry.
   * @param n - How many addresses.
   * @returns Each address's ledger key.
   */
  async function fetchAddresses(a: Account, lane: "canvas" | "document", n: number): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID();
      const body = lane === "canvas"
        ? { project_id: a.projectId, space_id: a.spaceId, url: `https://cdn.test.invalid/${i}.png`, node_id: crypto.randomUUID() }
        : { project_id: a.projectId, space_id: a.spaceId, url: `https://cdn.test.invalid/${i}.png` };
      const res = await request(app, a.cookie, "POST", lane === "canvas" ? "/canvas/ingest-url" : "/assets/ingest-url", body, { "Idempotency-Key": id });
      expect(res.status, await res.clone().text()).toBe(201);
      const key = `url:${a.userId}:${id}`;
      const [grant] = await sql<{ storage_key: string; source: string }[]>`select storage_key, source from upload_grants where operation_key = ${key}`;
      expect(grant?.source).toBe("url");
      await stored(grant!.storage_key);
      keys.push(key);
    }
    return keys;
  }

  it("B-21 ten addresses pasted on the canvas count ten times, each when its grant is consumed", async () => {
    const a = await seedAccount(sql);
    const keys = await fetchAddresses(a, "canvas", 10);
    for (const key of keys) expect(await ledgerRow(sql, key)).toMatchObject({ kind: "url_paste", status: "counted" });
    expect(await used(a)).toBe(10);
  });

  it("B-22 ten addresses pasted into a Document count ten times", async () => {
    const a = await seedAccount(sql);
    const keys = await fetchAddresses(a, "document", 10);
    for (const key of keys) expect((await ledgerRow(sql, key))?.status).toBe("counted");
    expect(await used(a)).toBe(10);
  });
});

describe("B.2 what is not counted", () => {
  it("B-38 a canvas paste writes no ledger row and no grant", async () => {
    const a = await seedAccount(sql);
    const res = await request(app, a.cookie, "POST", "/canvas/paste", { project_id: a.projectId, urls: [], pairs: [], history: [{ node_id: crypto.randomUUID(), kind: "text", content: "copied" }] });
    expect(res.status).toBe(200);
    expect(await ledgerRows(sql, a)).toEqual([]);
    expect(await grants(a)).toEqual([]);
  });
});

describe("B.3 derived images are deferred, not counted", () => {
  it("B-41 a chat attachment, derived but with no Space, counts like any upload", async () => {
    const a = await seedAccount(sql);
    const attached = await upload(a, { derived: true });
    expect((await ledgerRow(sql, attached.key))?.status).toBe("counted");
    expect(await used(a)).toBe(1);
  });

  it("B-42 a derived upload is deferred when its grant is consumed, with its asset and an audit line", async () => {
    const a = await seedAccount(sql);
    const logs = captureLogs("operation-upload-b42");
    const crop = await upload(a, { derived: true, space_id: a.spaceId });
    expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "deferred", asset_id: crop.assetId, absorbed_by: null });
    expect(await used(a)).toBe(0);
    expect(logs("operation_deferred")).toContainEqual(
      expect.objectContaining({ userId: a.userId, projectId: a.projectId, operationKey: crop.key, assetId: crop.assetId }),
    );
  });

  it("B-43 a derived upload that hits an image already stored is deferred too", async () => {
    const a = await seedAccount(sql);
    const asset = await seedAsset(sql, a.studioId, a.userId);
    const hit = await ticket(app, a, { derived: true, space_id: a.spaceId, client_hash: asset.hash });
    expect(hit.res.status).toBe(200);
    expect(await ledgerRow(sql, hit.key)).toMatchObject({ status: "deferred", asset_id: asset.id });
    expect(await used(a)).toBe(0);
  });

  it("B-44 an upload missing any one condition for deferring is counted", async () => {
    const a = await seedAccount(sql);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["registered as a video though declared a PNG", { derived: true, space_id: a.spaceId }, "video/mp4"],
      ["lands on a node", { derived: true, space_id: a.spaceId, node_id: crypto.randomUUID() }, "image/png"],
      ["has a purpose", { derived: true, purpose: "project_cover" }, "image/png"],
      ["has a source", { derived: true, space_id: a.spaceId, source: "mini_tool", tool_name: "image.crop" }, "image/png"],
      ["has no Space", { derived: true }, "image/png"],
    ];
    const statuses: Record<string, string | undefined> = {};
    for (const [name, file, reportedAs] of cases) statuses[name] = (await ledgerRow(sql, (await upload(a, file, reportedAs)).key))?.status;
    expect(statuses).toEqual(Object.fromEntries(cases.map(([name]) => [name, "counted"])));
  });
});

describe("B.4 the same key again", () => {
  it("B-67 a repeat while the first is still running is answered 409 in_progress, leaving one grant and one row", async () => {
    const a = await seedAccount(sql);
    let open!: () => void;
    const held = new Promise<string>((resolve) => { open = () => resolve("ok"); });
    setOpenMode(() => held);
    const key = crypto.randomUUID();
    const hash = crypto.randomBytes(32).toString("hex");
    const first = ticket(app, a, { client_hash: hash }, key);
    await new Promise((r) => setTimeout(r, 200));
    // The first stays open until the repeat has had its answer, or 500 ms at most.
    const released = setTimeout(open, 500);
    const second = await ticket(app, a, { client_hash: hash }, key);
    open();
    clearTimeout(released);
    expect(second.res.status).toBe(409);
    expect(second.res.headers.get("Idempotency-Status")).toBe("in_progress");
    expect((await first).res.status).toBe(201);
    expect(await grants(a)).toHaveLength(1);
    expect(await ledgerRows(sql, a)).toHaveLength(1);
  });

  it("B-68 a repeat after the first finished replays its answer and signs no second grant", async () => {
    const a = await seedAccount(sql);
    const key = crypto.randomUUID();
    const hash = crypto.randomBytes(32).toString("hex");
    const first = await ticket(app, a, { client_hash: hash }, key);
    const before = await ledgerRow(sql, first.key);
    const again = await ticket(app, a, { client_hash: hash }, key);
    expect(again.res.status).toBe(first.res.status);
    expect(await again.res.json()).toEqual(await first.res.json());
    expect(await grants(a)).toHaveLength(1);
    expect(await ledgerRow(sql, first.key)).toEqual(before);
  });

  it("B-69 the same key with a different body is 422 idempotency mismatch", async () => {
    const a = await seedAccount(sql);
    const key = crypto.randomUUID();
    await ticket(app, a, {}, key);
    const other = await ticket(app, a, { filename: "other.png" }, key);
    expect(other.res.status).toBe(422);
  });

  it.each(["/assets/upload-ticket", "/canvas/ingest-url", "/assets/ingest-url"])("B-70 %s without an Idempotency-Key is refused as request_shape and writes nothing", async (path) => {
    const a = await seedAccount(sql);
    const body = path === "/assets/upload-ticket"
      ? { filename: "photo.png", content_type: "image/png", size: 4096, client_hash: crypto.randomBytes(32).toString("hex"), project_id: a.projectId }
      : { project_id: a.projectId, space_id: a.spaceId, url: "https://cdn.test.invalid/a.png", ...(path === "/canvas/ingest-url" ? { node_id: crypto.randomUUID() } : {}) };
    const res = await request(app, a.cookie, "POST", path, body, { "Idempotency-Key": null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { reason?: string } }).error.reason).toBe("request_shape");
    expect(await ledgerRows(sql, a)).toEqual([]);
    expect(await grants(a)).toEqual([]);
  });

  it("B-71 once the run-once answer is forgotten, a counted key is refused 409 operation_key_taken and nothing is signed or counted again", async () => {
    const a = await seedAccount(sql);
    const key = crypto.randomUUID();
    const hash = crypto.randomBytes(32).toString("hex");
    const first = await ticket(app, a, { client_hash: hash }, key);
    await stored(first.storageKey!);
    expect((await ledgerRow(sql, first.key))?.status).toBe("counted");
    await forgetRunOnce(a);
    const logs = captureLogs("operation-upload-b71");
    const again = await ticket(app, a, { client_hash: hash }, key);
    expect(again.res.status).toBe(409);
    expect(((await again.res.json()) as { error: { reason?: string } }).error.reason).toBe("operation_key_taken");
    expect(await grants(a)).toHaveLength(1);
    expect(await used(a)).toBe(1);
    expect(logs("operation_key_taken")).toContainEqual(expect.objectContaining({ userId: a.userId, projectId: a.projectId, key: first.key }));
  });

  it("B-77 the many-file ticket form for the grid is gone", async () => {
    const a = await seedAccount(sql);
    const res = await request(app, a.cookie, "POST", "/assets/upload-ticket", {
      project_id: a.projectId, space_id: a.spaceId, source: "mini_tool", tool_name: "image.grid",
      items: [1, 2].map(() => ({ filename: "tile.png", content_type: "image/png", size: 100, client_hash: crypto.randomBytes(32).toString("hex"), node_id: crypto.randomUUID() })),
    });
    expect([400, 404, 422]).toContain(res.status);
    expect(await grants(a)).toEqual([]);
  });
});
