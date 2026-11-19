// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each member last had on screen in a Project (#1488 §6): written from
 * their awareness, kept alive by their socket's signs of life, and read by
 * the external agent's reads and placements.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClient, type Redis } from "@breatic/core";
import { readLastViews, recordLastView, renewLastViews, viewOfAwareness } from "@collab/services/last-view-cache.js";

let redis: Redis;
beforeAll(async () => {
  redis = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-last-view" });
  await redis.connect();
});
afterAll(async () => {
  await redis.quit();
});

const VIEW = {
  activeNodeIds: ["n1"],
  pointer: { x: 10, y: 20 },
  camera: { x: 0, y: 0, width: 800, height: 600 },
  cursor: null,
};

describe("viewOfAwareness", () => {
  it("keeps the canvas fields a browser publishes and drops everything else", () => {
    expect(
      viewOfAwareness({
        user: { id: "u" },
        activeNodeIds: ["a", "b"],
        pointer: { x: 1, y: 2 },
        gesture: { anything: true },
        camera: { x: 3, y: 4, width: 5, height: 6, at: 7 },
      }),
    ).toEqual({ activeNodeIds: ["a", "b"], pointer: { x: 1, y: 2 }, camera: { x: 3, y: 4, width: 5, height: 6 }, cursor: null });
  });

  it("keeps a document caret", () => {
    const cursor = { anchor: { type: null, tname: "doc", item: { client: 1, clock: 2 }, assoc: 0 }, head: { type: null, tname: "doc", item: { client: 1, clock: 5 }, assoc: 0 } };
    expect(viewOfAwareness({ cursor })).toEqual({ activeNodeIds: null, pointer: null, camera: null, cursor });
  });

  it("reads a malformed field as absent", () => {
    expect(viewOfAwareness({ activeNodeIds: [1, 2], pointer: { x: "1" }, camera: { x: Infinity }, cursor: "x" })).toEqual({
      activeNodeIds: null,
      pointer: null,
      camera: null,
      cursor: null,
    });
  });

  it("answers null for a state that carries no view at all", () => {
    expect(viewOfAwareness({ user: { id: "u" } })).toBeNull();
    expect(viewOfAwareness(null)).toBeNull();
  });
});

describe("the cache", () => {
  it("returns each member's last view in the Project, newest write winning", async () => {
    const prefix = `itest-lv-${randomUUID().slice(0, 8)}`;
    const projectId = randomUUID();
    const [alice, bob] = [randomUUID(), randomUUID()];
    const [space1, space2] = [randomUUID(), randomUUID()];
    const now = Date.now();
    await recordLastView(redis, prefix, { projectId, userId: alice, spaceId: space1, view: VIEW }, 60_000, now);
    await recordLastView(redis, prefix, { projectId, userId: alice, spaceId: space2, view: { ...VIEW, activeNodeIds: null } }, 60_000, now + 1);
    await recordLastView(redis, prefix, { projectId, userId: bob, spaceId: space1, view: VIEW }, 60_000, now);
    const views = await readLastViews(redis, prefix, projectId, now + 2);
    expect(views.map((v) => [v.userId, v.spaceId, v.activeNodeIds]).sort()).toEqual(
      [
        [alice, space2, null],
        [bob, space1, ["n1"]],
      ].sort(),
    );
    expect(await readLastViews(redis, prefix, randomUUID(), now)).toEqual([]);
  });

  it("forgets a member whose socket has not been heard within the expiry, unless renewed", async () => {
    const prefix = `itest-lv-${randomUUID().slice(0, 8)}`;
    const projectId = randomUUID();
    const [kept, gone] = [randomUUID(), randomUUID()];
    const spaceId = randomUUID();
    const now = Date.now();
    await recordLastView(redis, prefix, { projectId, userId: kept, spaceId, view: VIEW }, 300, now);
    await recordLastView(redis, prefix, { projectId, userId: gone, spaceId, view: VIEW }, 300, now);
    await renewLastViews(redis, prefix, [{ projectId, userId: kept }], 60_000, now + 200);
    await new Promise((r) => setTimeout(r, 400));
    expect((await readLastViews(redis, prefix, projectId, Date.now())).map((v) => v.userId)).toEqual([kept]);
  });

  it("renews nothing for a member who never published a view", async () => {
    const prefix = `itest-lv-${randomUUID().slice(0, 8)}`;
    const projectId = randomUUID();
    await renewLastViews(redis, prefix, [{ projectId, userId: randomUUID() }], 60_000, Date.now());
    expect(await readLastViews(redis, prefix, projectId, Date.now())).toEqual([]);
  });
});
