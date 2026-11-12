// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A document's snapshots follow its Space through deletion and restore
 * (inner#1129 A9): collab deletes and restores the Space for real, and the
 * server's snapshot routes answer with the snapshots it had before.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Server, type Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import postgres from "postgres";
import * as Y from "yjs";
import { createRedisClient, initCore, loadLocales, writeSpaceEntry } from "@breatic/core";
import { projectMetaDocName, spaceContentDocName, type SpaceRpcRequest, type SpaceRpcResponse } from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { createPersistenceExtension } from "@collab/services/persistence.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";
import { seedProject, type Seeded } from "@server/__tests__/integration/transfer-fixtures.js";
import type { createApp } from "@server/app.js";

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let hocuspocus: Hocuspocus;
let server: Server;

beforeAll(async () => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  app = (await import("@server/app.js")).createApp();
  const collabUrl = process.env.REDIS_COLLAB_URL;
  if (!collabUrl) throw new Error("REDIS_COLLAB_URL missing from the integration env");
  // One collab instance wired as production wires it, as the collab suites do.
  server = new Server({
    port: 0,
    quiet: true,
    stopOnSignals: false,
    debounce: 50,
    unloadImmediately: true,
    extensions: [
      createChangeTrackingExtension(),
      createPersistenceExtension(),
      new RedisExtension({ createClient: () => createRedisClient(collabUrl, { name: "document-versions" }), prefix: "itest-docver:hocuspocus" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[],
  });
  await server.listen();
  hocuspocus = server.hocuspocus;
});

afterAll(async () => {
  await server?.destroy();
  await sql?.end({ timeout: 1 });
});

/**
 * A project whose meta document lists two document Spaces.
 * @returns The project, its members and the Spaces.
 */
async function projectWithDocuments(): Promise<Seeded & { spaceId: string; otherId: string }> {
  const seeded = await seedProject(sql);
  const meta = new Y.Doc();
  const [spaceId, otherId] = [crypto.randomUUID(), crypto.randomUUID()];
  [spaceId, otherId].forEach((id, order) =>
    writeSpaceEntry(meta.getMap("spaces"), { spaceId: id, type: "document", name: `D${order}`, order, createdAt: 1, createdBy: seeded.a.id }),
  );
  await yjsRepo.upsertDocData(projectMetaDocName(seeded.projectId), Y.encodeStateAsUpdate(meta));
  for (const id of [spaceId, otherId]) {
    await yjsRepo.upsertDocData(spaceContentDocName(seeded.projectId, id, "document"), Y.encodeStateAsUpdate(new Y.Doc()));
  }
  meta.destroy();
  return { ...seeded, spaceId, otherId };
}

/**
 * One Space RPC from the project's owner.
 * @param w - The project.
 * @param body - The request without its id.
 * @returns The answer.
 */
function rpc(w: Seeded, body: Omit<SpaceRpcRequest, "id">): Promise<SpaceRpcResponse> {
  return handleSpaceRpc({ hocuspocus }, w.projectId, { userId: w.a.id, role: "owner" }, { id: crypto.randomUUID(), ...body } as SpaceRpcRequest);
}

/**
 * The ids the server lists for a document, newest first.
 * @param w - The project.
 * @param spaceId - The document.
 * @returns The ids.
 */
async function listed(w: Seeded, spaceId: string): Promise<string[]> {
  const res = await app.request(`/api/v1/documents/versions?project_id=${w.projectId}&space_id=${spaceId}`, { headers: { Cookie: w.a.cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { versions: { id: string }[] } };
  return body.data.versions.map((v) => v.id);
}

describe("snapshots across a Space's deletion and restore", () => {
  it("lists the same snapshots after the Space is deleted and restored", async () => {
    const w = await projectWithDocuments();
    const saved: string[] = [];
    for (const name of ["first", "second"]) {
      const res = await app.request("/api/v1/documents/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: w.a.cookie },
        body: JSON.stringify({ project_id: w.projectId, space_id: w.spaceId, name, content: { type: "doc", content: [] }, schema_version: "v1" }),
      });
      expect(res.status).toBe(201);
      saved.unshift(((await res.json()) as { data: { version: { id: string } } }).data.version.id);
    }
    const before = await listed(w, w.spaceId);
    expect(before).toEqual(saved);

    expect(await rpc(w, { type: "space:delete", payload: { spaceId: w.spaceId } })).toMatchObject({ ok: true });
    expect(await sql`SELECT 1 FROM document_versions WHERE space_id = ${w.spaceId} AND deleted_at IS NOT NULL`).toHaveLength(0);

    expect(await rpc(w, { type: "space:restore", payload: { spaceId: w.spaceId } })).toMatchObject({ ok: true });
    expect(await listed(w, w.spaceId)).toEqual(before);
    expect(await listed(w, w.otherId)).toEqual([]);
  });
});
