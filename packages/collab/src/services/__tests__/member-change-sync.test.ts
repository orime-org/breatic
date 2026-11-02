// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Applying `project_members` changes to this instance's open connections
 * (inner#911).
 *
 *   - A change closes the named person's connections on the named project, so
 *     the web client re-authenticates against the row as it now stands.
 *   - Each time listening starts — the first time and after every reconnect —
 *     every registered connection is checked against its current role, which
 *     covers changes committed while nobody was listening.
 */

import { describe, it, expect, vi } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";
import { COLLAB_REAUTH_REASONS, type ProjectRole } from "@breatic/shared";

const logged = vi.hoisted(() => ({ error: [] as unknown[][] }));
vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: (...args: unknown[]) => logged.error.push(args),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  kickUserFromProject,
  recheckAllConnections,
  startMemberChangeSync,
} from "@collab/services/member-change-sync.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-9222-222222222222";
const SPACE = "33333333-3333-4333-a333-333333333333";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface FakeConnection {
  docName: string;
  user: { id: string; role: ProjectRole } | undefined;
}

/**
 * A Hocuspocus whose documents hold the given connections, each recording how
 * it was closed.
 * @param conns - The connections, by document and the user their handshake set.
 * @returns The fake server and the closes, in order.
 */
function makeHocuspocus(conns: FakeConnection[]): {
  hocuspocus: Hocuspocus;
  closed: Array<{ docName: string; userId: string | undefined; code: number; reason: string }>;
} {
  const closed: Array<{ docName: string; userId: string | undefined; code: number; reason: string }> = [];
  const documents = new Map<string, { connections: Map<unknown, unknown> }>();
  for (const c of conns) {
    const doc = documents.get(c.docName) ?? { connections: new Map<unknown, unknown>() };
    documents.set(c.docName, doc);
    doc.connections.set(
      {
        context: c.user ? { user: c.user, seatCap: null, arrivedAtMs: 0 } : undefined,
        close: ({ code, reason }: { code: number; reason: string }) =>
          closed.push({ docName: c.docName, userId: c.user?.id, code, reason }),
      },
      { clients: new Set<number>() },
    );
  }
  return { hocuspocus: { documents } as unknown as Hocuspocus, closed };
}

const META_1 = `project-${P1}/meta`;
const CANVAS_1 = `project-${P1}/canvas-${SPACE}`;
const META_2 = `project-${P2}/meta`;

describe("kickUserFromProject", () => {
  it("closes the person's connections on every document of the project and nothing else", () => {
    const { hocuspocus, closed } = makeHocuspocus([
      { docName: META_1, user: { id: ALICE, role: "editor" } },
      { docName: CANVAS_1, user: { id: ALICE, role: "editor" } },
      { docName: CANVAS_1, user: { id: BOB, role: "editor" } },
      { docName: META_2, user: { id: ALICE, role: "editor" } },
    ]);

    kickUserFromProject(hocuspocus, P1, ALICE);

    expect(closed).toEqual([
      { docName: META_1, userId: ALICE, code: 4403, reason: COLLAB_REAUTH_REASONS.permissionChanged },
      { docName: CANVAS_1, userId: ALICE, code: 4403, reason: COLLAB_REAUTH_REASONS.permissionChanged },
    ]);
  });
});

describe("recheckAllConnections", () => {
  it("closes each connection whose role has changed and leaves the rest open", async () => {
    const { hocuspocus, closed } = makeHocuspocus([
      { docName: CANVAS_1, user: { id: ALICE, role: "editor" } },
      { docName: CANVAS_1, user: { id: BOB, role: "editor" } },
      { docName: META_2, user: { id: ALICE, role: "viewer" } },
    ]);
    const now: Record<string, ProjectRole | null> = {
      [`${ALICE}:${P1}`]: null,
      [`${BOB}:${P1}`]: "editor",
      [`${ALICE}:${P2}`]: "editor",
    };

    await recheckAllConnections(hocuspocus, async (userId, projectId) => now[`${userId}:${projectId}`] ?? null);

    expect(closed.map((c) => [c.docName, c.userId])).toEqual([
      [CANVAS_1, ALICE],
      [META_2, ALICE],
    ]);
  });

  it("skips a connection whose handshake has not set a user", async () => {
    const { hocuspocus, closed } = makeHocuspocus([{ docName: CANVAS_1, user: undefined }]);
    const loadRole = vi.fn(async () => null);

    await recheckAllConnections(hocuspocus, loadRole);

    expect(loadRole).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
  });

  it("keeps checking the rest when one role read fails, and logs the failure", async () => {
    logged.error.length = 0;
    const { hocuspocus, closed } = makeHocuspocus([
      { docName: CANVAS_1, user: { id: ALICE, role: "editor" } },
      { docName: META_2, user: { id: BOB, role: "editor" } },
    ]);

    await recheckAllConnections(hocuspocus, async (userId) => {
      if (userId === ALICE) throw new Error("db down");
      return null;
    });

    expect(closed.map((c) => c.userId)).toEqual([BOB]);
    expect(logged.error).toHaveLength(1);
  });
});

describe("startMemberChangeSync", () => {
  /**
   * Start the sync against a captured listener.
   * @param conns - The connections the instance holds.
   * @param loadRole - The current-role reader.
   * @returns The handlers the sync registered, the closes, and the stop.
   */
  async function start(
    conns: FakeConnection[],
    loadRole: (userId: string, projectId: string) => Promise<ProjectRole | null> = async () => null,
  ): Promise<{
    handlers: {
      onChange: (c: { projectId: string; userId: string }) => void;
      onListening: () => void;
      onInvalid: (raw: string) => void;
    };
    closed: ReturnType<typeof makeHocuspocus>["closed"];
    stopped: () => boolean;
    stop: () => Promise<void>;
  }> {
    const { hocuspocus, closed } = makeHocuspocus(conns);
    let handlers: Parameters<Parameters<typeof startMemberChangeSync>[1]["listen"]>[0] | undefined;
    let stopped = false;
    const sync = await startMemberChangeSync(hocuspocus, {
      listen: async (h) => {
        handlers = h;
        return {
          stop: async () => {
            stopped = true;
          },
          probe: async () => true,
        };
      },
      loadRole,
    });
    if (!handlers) throw new Error("listen was not called");
    return { handlers, closed, stopped: () => stopped, stop: () => sync.stop() };
  }

  it("closes the named person's connections on a change", async () => {
    const { handlers, closed } = await start([
      { docName: CANVAS_1, user: { id: ALICE, role: "editor" } },
      { docName: CANVAS_1, user: { id: BOB, role: "editor" } },
    ]);

    handlers.onChange({ projectId: P1, userId: BOB });

    expect(closed.map((c) => c.userId)).toEqual([BOB]);
  });

  it("re-checks every connection each time listening starts", async () => {
    const { handlers, closed } = await start(
      [{ docName: CANVAS_1, user: { id: ALICE, role: "editor" } }],
      async () => null,
    );

    handlers.onListening();
    await vi.waitFor(() => expect(closed.map((c) => c.userId)).toEqual([ALICE]));
  });

  it("logs a payload it cannot read", async () => {
    logged.error.length = 0;
    const { handlers } = await start([]);

    handlers.onInvalid("not json");

    expect(logged.error).toHaveLength(1);
    expect(JSON.stringify(logged.error[0])).toContain("not json");
  });

  it("stops the listener when stopped", async () => {
    const { stop, stopped } = await start([]);

    await stop();

    expect(stopped()).toBe(true);
  });
});
