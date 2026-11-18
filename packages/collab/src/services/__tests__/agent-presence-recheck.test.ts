// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { canvasSpaceDocName, projectMetaDocName } from "@breatic/shared";

import { listAgentPresence, markAgentActive } from "@collab/hooks/presence.js";
import { endOwnerAgents, recheckAgentsInMeta, recheckLoadedAgents } from "@collab/services/agent-presence-recheck.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-9222-222222222222";

/**
 * A meta document with u1's agents c1 and c2 and u2's agent c3 online.
 * @returns The document.
 */
function metaWithAgents(): Y.Doc {
  const meta = Object.assign(new Y.Doc(), { connections: new Map() });
  for (const [userId, connectionId] of [["u1", "c1"], ["u1", "c2"], ["u2", "c3"]] as const) {
    markAgentActive({ document: meta, userId, connectionId, spaceId: null, focus: undefined, now: 0 });
  }
  return meta;
}

/**
 * Which agent connections a meta document shows online.
 * @param meta - The document.
 * @returns Their ids, sorted.
 */
function online(meta: Y.Doc): string[] {
  return listAgentPresence(meta).filter((a) => a.online).map((a) => a.connectionId).sort();
}

describe("recheckAgentsInMeta", () => {
  it("marks offline the agents whose connection is unusable or whose owner left the project", async () => {
    const meta = metaWithAgents();
    await recheckAgentsInMeta(meta, P1, {
      isConnectionUsable: async (id) => id !== "c1",
      loadRole: async (userId) => (userId === "u2" ? null : "editor"),
    });
    expect(online(meta)).toEqual(["c2"]);
  });

  it("asks about each owner once and checks only agents still online", async () => {
    const meta = metaWithAgents();
    const asked: string[] = [];
    await recheckAgentsInMeta(meta, P1, {
      isConnectionUsable: async (id) => {
        asked.push(id);
        return id !== "c3";
      },
      loadRole: async () => "viewer",
    });
    await recheckAgentsInMeta(meta, P1, {
      isConnectionUsable: async (id) => {
        asked.push(id);
        return true;
      },
      loadRole: async () => "viewer",
    });
    expect(asked.sort()).toEqual(["c1", "c1", "c2", "c2", "c3"]);
  });

  it("changes nothing when a check fails, and throws", async () => {
    const meta = metaWithAgents();
    await expect(
      recheckAgentsInMeta(meta, P1, {
        isConnectionUsable: async () => {
          throw new Error("database down");
        },
        loadRole: async () => "editor",
      }),
    ).rejects.toThrow("database down");
    expect(online(meta)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("endOwnerAgents", () => {
  it("marks offline one owner's agents in that project's loaded meta only", () => {
    const here = metaWithAgents();
    const elsewhere = metaWithAgents();
    const hocuspocus = {
      documents: new Map<string, unknown>([
        [projectMetaDocName(P1), here],
        [projectMetaDocName(P2), elsewhere],
        [canvasSpaceDocName(P1, "33333333-3333-4333-a333-333333333333"), new Y.Doc()],
      ]),
    } as unknown as Hocuspocus;
    endOwnerAgents(hocuspocus, P1, "u1");
    expect(online(here)).toEqual(["c3"]);
    expect(online(elsewhere)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("recheckLoadedAgents", () => {
  it("rechecks every loaded meta document against its own project", async () => {
    const one = metaWithAgents();
    const two = metaWithAgents();
    const hocuspocus = {
      documents: new Map<string, unknown>([
        [projectMetaDocName(P1), one],
        [projectMetaDocName(P2), two],
      ]),
    } as unknown as Hocuspocus;
    await recheckLoadedAgents(hocuspocus, {
      isConnectionUsable: async () => true,
      loadRole: async (_userId, projectId) => (projectId === P2 ? null : "owner"),
    });
    expect(online(one)).toEqual(["c1", "c2", "c3"]);
    expect(online(two)).toEqual([]);
  });
});
