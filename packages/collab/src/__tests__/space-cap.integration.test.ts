// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Space cap across two collab instances on a real Postgres and a real
 * Redis (inner#1140). A project holds at most MAX_SPACES_PER_PROJECT live
 * Spaces: the last place can be taken and the next create is refused without
 * writing anything, two creates racing for the last place on different
 * instances leave exactly one through, creates far below the cap all go
 * through, a lock held through the whole wait answers BUSY, and a restore at
 * the cap is refused until a place is free.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import * as Y from "yjs";

import { initCore, createRedisClient, env, getCollabRedis, rawPg as sql, writeSpaceEntry } from "@breatic/core";
import {
  MAX_SPACES_PER_PROJECT,
  projectMetaDocName,
  spaceContentDocName,
  type SpaceRpcRequest,
  type SpaceRpcResponse,
} from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { createPersistenceExtension } from "@collab/services/persistence.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import { readListedContentDocNames } from "@collab/services/project-space-list.js";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";

type RpcBody = Omit<SpaceRpcRequest, "id">;

let instanceA: Hocuspocus;
let instanceB: Hocuspocus;
const servers: Array<{ destroy: () => Promise<void> }> = [];
let seq = 0;

/**
 * One collab instance wired the way production wires it.
 * @param name - Distinguishes the instances' Redis clients.
 * @returns The running server's Hocuspocus instance.
 * @throws {Error} When the integration environment has no `REDIS_COLLAB_URL`.
 */
async function startInstance(name: string): Promise<Hocuspocus> {
  const collabUrl = process.env.REDIS_COLLAB_URL;
  if (!collabUrl) throw new Error("REDIS_COLLAB_URL missing from the integration env");
  const wsServer = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    unloadImmediately: true,
    extensions: [
      createChangeTrackingExtension(),
      createPersistenceExtension(),
      new RedisExtension({
        createClient: () => createRedisClient(collabUrl, { name }),
        prefix: "itest-cap:hocuspocus",
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[],
  });
  await wsServer.listen();
  servers.push({ destroy: () => wsServer.destroy() });
  return wsServer.hocuspocus;
}

/**
 * A project in the business database, owned by a fresh user, whose meta doc
 * and content rows already hold `spaces` canvas Spaces.
 * @param spaces - How many live Spaces it starts with.
 * @returns The project id, its owner, and the id of its first Space.
 */
async function projectWith(
  spaces: number,
): Promise<{ projectId: string; ownerId: string; firstSpaceId: string }> {
  seq += 1;
  const tag = `${process.pid}-${seq}-${crypto.randomUUID().slice(0, 8)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`cap-${tag}@example.com`}, true)
    RETURNING id`;
  const ownerId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${ownerId}, ${`cap-studio-${tag}`}, 'personal', 'cap')
    RETURNING id`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${ownerId}, 'cap', ${`cap-${tag}`})
    RETURNING id`;
  const projectId = project!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerId}, 'owner', ${ownerId})`;

  const doc = new Y.Doc();
  const map = doc.getMap("spaces");
  const ids = Array.from({ length: spaces }, () => crypto.randomUUID());
  ids.forEach((spaceId, order) =>
    writeSpaceEntry(map, { spaceId, type: "canvas", name: `S${order}`, order, createdAt: 1, createdBy: ownerId }),
  );
  await yjsRepo.upsertDocData(projectMetaDocName(projectId), Y.encodeStateAsUpdate(doc));
  for (const spaceId of ids) {
    await yjsRepo.upsertDocData(spaceContentDocName(projectId, spaceId, "canvas"), Y.encodeStateAsUpdate(new Y.Doc()));
  }
  doc.destroy();
  return { projectId, ownerId, firstSpaceId: ids[0]! };
}

/**
 * Send one Space RPC as the project's owner through an instance.
 * @param instance - The collab instance that receives it.
 * @param projectId - The project.
 * @param ownerId - The caller.
 * @param body - The request, without an id.
 * @returns The answer.
 */
function rpc(instance: Hocuspocus, projectId: string, ownerId: string, body: RpcBody): Promise<SpaceRpcResponse> {
  return handleSpaceRpc(
    { hocuspocus: instance },
    projectId,
    { userId: ownerId, role: "owner" },
    { id: crypto.randomUUID(), ...body } as SpaceRpcRequest,
  );
}

/**
 * A create request.
 * @param name - The new Space's name.
 * @returns The request body.
 */
function create(name: string): RpcBody {
  return { type: "space:create", payload: { type: "canvas", name, claimToken: crypto.randomUUID() } };
}

/**
 * The error code of an answer, or "ok".
 * @param res - The answer.
 * @returns The code.
 */
function outcome(res: SpaceRpcResponse): string {
  return res.ok ? "ok" : res.error.code;
}

/**
 * How many Spaces the meta doc lists, as an instance sees it.
 * @param instance - The collab instance to ask.
 * @param projectId - The project.
 * @returns The number of listed content docs.
 */
async function listedCount(instance: Hocuspocus, projectId: string): Promise<number> {
  const names = await readListedContentDocNames(projectId, instance, new Request("http://localhost"), "space-cap-test");
  return names.size;
}

beforeAll(async () => {
  initCore(process.env);
  instanceA = await startInstance("cap-a");
  instanceB = await startInstance("cap-b");
});

afterEach(async () => {
  const keys = await getCollabRedis().keys(`${env.ENV}:collab:lock:space-delete:*`);
  if (keys.length > 0) await getCollabRedis().del(...keys);
});

afterAll(async () => {
  for (const s of servers) await s.destroy();
}, 60_000);

describe("restoring a Space on real Postgres", () => {
  it("brings back only the content row of the Space's own type", async () => {
    const { projectId, ownerId, firstSpaceId } = await projectWith(3);
    // A row of another kind under the Space's id, as the repair leaves one.
    const otherKind = spaceContentDocName(projectId, firstSpaceId, "document");
    await yjsRepo.upsertDocData(otherKind, Y.encodeStateAsUpdate(new Y.Doc()));
    await yjsRepo.softDeleteByName(otherKind);

    const body = (type: "space:delete" | "space:restore"): RpcBody =>
      ({ type, payload: { spaceId: firstSpaceId } });
    expect(outcome(await rpc(instanceA, projectId, ownerId, body("space:delete")))).toBe("ok");
    expect(outcome(await rpc(instanceA, projectId, ownerId, body("space:restore")))).toBe("ok");

    expect(await yjsRepo.fetchDocData(spaceContentDocName(projectId, firstSpaceId, "canvas"))).not.toBeNull();
    expect(await yjsRepo.fetchDocData(otherKind)).toBeNull();
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(3);
  });
});

describe("the Space cap on real Postgres and Redis", () => {
  it("creates the last Space and refuses the next one without writing anything", async () => {
    const { projectId, ownerId } = await projectWith(MAX_SPACES_PER_PROJECT - 1);

    expect(outcome(await rpc(instanceA, projectId, ownerId, create("last")))).toBe("ok");
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(MAX_SPACES_PER_PROJECT);
    expect(await listedCount(instanceA, projectId)).toBe(MAX_SPACES_PER_PROJECT);

    expect(outcome(await rpc(instanceA, projectId, ownerId, create("over")))).toBe("SPACE_LIMIT");
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(MAX_SPACES_PER_PROJECT);
    expect(await listedCount(instanceA, projectId)).toBe(MAX_SPACES_PER_PROJECT);
  });

  it("lets exactly one of two creates racing for the last place through, on different instances", async () => {
    const { projectId, ownerId } = await projectWith(MAX_SPACES_PER_PROJECT - 1);

    const answers = await Promise.all([
      rpc(instanceA, projectId, ownerId, create("from A")),
      rpc(instanceB, projectId, ownerId, create("from B")),
    ]);

    expect(answers.map(outcome).sort()).toEqual(["SPACE_LIMIT", "ok"]);
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(MAX_SPACES_PER_PROJECT);
    await vi.waitFor(async () => expect(await listedCount(instanceA, projectId)).toBe(MAX_SPACES_PER_PROJECT));
  });

  it("lets every create through far below the cap, on both instances at once", async () => {
    const { projectId, ownerId } = await projectWith(1);

    const answers = await Promise.all([
      rpc(instanceA, projectId, ownerId, create("one")),
      rpc(instanceB, projectId, ownerId, create("two")),
      rpc(instanceA, projectId, ownerId, create("three")),
    ]);

    expect(answers.map(outcome)).toEqual(["ok", "ok", "ok"]);
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(4);
  });

  it("answers BUSY when the lock stays held through the whole wait", async () => {
    const { projectId, ownerId } = await projectWith(1);
    await getCollabRedis().set(`${env.ENV}:collab:lock:space-delete:${projectId}`, "held-elsewhere", "EX", 30);

    expect(outcome(await rpc(instanceA, projectId, ownerId, create("waits")))).toBe("BUSY");
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(1);
  }, 15_000);

  it("refuses a restore at the cap and lets it through once a place is free", async () => {
    const { projectId, ownerId, firstSpaceId } = await projectWith(MAX_SPACES_PER_PROJECT - 1);
    const deleteBody = (spaceId: string): RpcBody => ({ type: "space:delete", payload: { spaceId } });
    const restoreBody: RpcBody = { type: "space:restore", payload: { spaceId: firstSpaceId } };

    expect(outcome(await rpc(instanceA, projectId, ownerId, deleteBody(firstSpaceId)))).toBe("ok");
    const filled = await rpc(instanceA, projectId, ownerId, create("fill 1"));
    expect(outcome(await rpc(instanceA, projectId, ownerId, create("fill 2")))).toBe("ok");
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(MAX_SPACES_PER_PROJECT);

    expect(outcome(await rpc(instanceB, projectId, ownerId, restoreBody))).toBe("SPACE_LIMIT");
    expect(await yjsRepo.fetchDocData(spaceContentDocName(projectId, firstSpaceId, "canvas"))).toBeNull();
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(MAX_SPACES_PER_PROJECT);

    if (!filled.ok || !filled.result) throw new Error("the fill create did not answer with its Space");
    expect(outcome(await rpc(instanceA, projectId, ownerId, deleteBody(filled.result.spaceId)))).toBe("ok");
    expect(outcome(await rpc(instanceB, projectId, ownerId, restoreBody))).toBe("ok");
    expect(await yjsRepo.fetchDocData(spaceContentDocName(projectId, firstSpaceId, "canvas"))).not.toBeNull();
    expect(await yjsRepo.countLiveSpaceDocs(projectId)).toBe(MAX_SPACES_PER_PROJECT);
  });
});
