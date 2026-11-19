// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A derived write leaves no asset row and no storage usage (inner#1306 test plan §97 D21-1, D23-1; root AGENTS.md Storage,
 * transfer paragraph: "no `studio_assets` row and no storage usage").
 *
 * Real PostgreSQL grant, owner studio and registration; only the ingest Worker's link fetch (`fetchUrlToIngest`) is
 * controlled, answering the measurements the Worker reports on the stored bytes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, initCore, loadLocales } from "@breatic/core";
import type * as sharedModule from "@breatic/shared";
import * as domain from "@domain/index.js";

const fetchUrlToIngest = vi.hoisted(() => vi.fn());
vi.mock("@breatic/shared", async (importOriginal) => ({ ...(await importOriginal<typeof sharedModule>()), fetchUrlToIngest }));

type Derived = (sourceUrl: string, target: { storageKey: string; contentType: string; projectId: string; actingUserId: string; deadlineAt: number }) =>
  Promise<{ storageKey: string; sha256: string; size: number; contentType: string }>;
let pg: ReturnType<typeof createPgClient>;

beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", UPLOAD_BASE_URL: "https://assets.example.test",
    INGEST_BASE_URL: "https://ingest.example.test", INGEST_SHARED_SECRET: "fixture-ingest-secret" });
  loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "derived-write", max: 2 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/**
 * A user, a studio and its project.
 * @returns Their ids.
 */
async function seed(): Promise<{ userId: string; studioId: string; projectId: string }> {
  const userId = randomUUID(); const studioId = randomUUID(); const projectId = randomUUID();
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${userId},${`derived-${userId}@example.test`},true)`;
  await pg`INSERT INTO studios (id,created_by_user_id,slug,type,name) VALUES (${studioId},${userId},${`s-${studioId}`},'team','Derived')`;
  await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${projectId},${studioId},${userId},${`p-${projectId}`},'Derived')`;
  return { userId, studioId, projectId };
}

describe("a derived write registers nothing (§97 D21-1, D23-1)", () => {
  it("DV02 / DV04 leaves no studio_assets row at the key and the owner studio's storage usage unchanged", async () => {
    const service = (domain as unknown as { backendUploadService: { transferUrlToDerived?: Derived } }).backendUploadService;
    expect(service.transferUrlToDerived, "backendUploadService.transferUrlToDerived exists").toBeTypeOf("function");
    const f = await seed();
    const key = `${randomUUID().replaceAll("-", "")}${"0".repeat(32)}:${randomUUID()}`;
    fetchUrlToIngest.mockResolvedValue({ sha256: "a".repeat(64), sizeBytes: 5_000_000, contentType: "video/mp4" });
    const before = await domain.assetRepo.usageByStudio(f.studioId);
    const answer = await service.transferUrlToDerived!("https://provider.example.test/gen/person-1.mp4",
      { storageKey: key, contentType: "video/mp4", projectId: f.projectId, actingUserId: f.userId, deadlineAt: Date.now() + 3_600_000 });
    expect(answer).toEqual({ storageKey: key, sha256: "a".repeat(64), size: 5_000_000, contentType: "video/mp4" });
    const [rows] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM studio_assets WHERE storage_key=${key}`;
    expect(rows!.n).toBe(0);
    expect(await domain.assetRepo.usageByStudio(f.studioId)).toBe(before);
  });
});
