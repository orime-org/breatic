// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";
import { projectMetaDocName } from "@breatic/shared";

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { relayNotificationsChanged } from "@collab/services/project-control-sync.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";

/**
 * A connection on a document, opened by one user.
 * @param userId - Whose.
 * @returns The connection and what it was sent.
 */
function connection(userId: string): { context: { user: { id: string } }; sendStateless: ReturnType<typeof vi.fn> } {
  return { context: { user: { id: userId } }, sendStateless: vi.fn() };
}

describe("relayNotificationsChanged (breatic#1488 §11.9)", () => {
  it("tells each named user's meta connections in every project, and nobody else", () => {
    const aliceInA = connection("alice");
    const aliceInB = connection("alice");
    const bobInA = connection("bob");
    const carolInB = connection("carol");
    const aliceOnCanvas = connection("alice");
    const hocuspocus = {
      documents: new Map([
        [projectMetaDocName(PROJECT_A), { connections: new Map([[aliceInA, {}], [bobInA, {}]]) }],
        [projectMetaDocName(PROJECT_B), { connections: new Map([[aliceInB, {}], [carolInB, {}]]) }],
        [`project-${PROJECT_A}/canvas-22222222-2222-4222-8222-222222222222`, { connections: new Map([[aliceOnCanvas, {}]]) }],
      ]),
    } as unknown as Hocuspocus;
    relayNotificationsChanged(hocuspocus, { type: "notifications:changed", userIds: ["alice", "bob"], ts: 1 });
    const signal = JSON.stringify({ t: "notifications:changed" });
    expect(aliceInA.sendStateless).toHaveBeenCalledWith(signal);
    expect(aliceInB.sendStateless).toHaveBeenCalledWith(signal);
    expect(bobInA.sendStateless).toHaveBeenCalledWith(signal);
    expect(carolInB.sendStateless).not.toHaveBeenCalled();
    expect(aliceOnCanvas.sendStateless).not.toHaveBeenCalled();
  });

  it("keeps telling the others when one connection fails", () => {
    const broken = connection("alice");
    broken.sendStateless.mockImplementation(() => {
      throw new Error("closed");
    });
    const healthy = connection("alice");
    const hocuspocus = {
      documents: new Map([[projectMetaDocName(PROJECT_A), { connections: new Map([[broken, {}], [healthy, {}]]) }]]),
    } as unknown as Hocuspocus;
    expect(() => relayNotificationsChanged(hocuspocus, { type: "notifications:changed", userIds: ["alice"], ts: 1 })).not.toThrow();
    expect(healthy.sendStateless).toHaveBeenCalled();
  });
});
