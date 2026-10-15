// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Closing one project's connections on this instance (inner#1497 §6.2).
 *
 * Every instance runs this when the project's `connections:close` control
 * event arrives, so each closes only the connections it holds. The reason is
 * the contract with the web client: for these reasons it re-sends its token on
 * the same socket and comes back with whatever the project now allows.
 */

import { describe, expect, it } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";

import { closeProjectConnections } from "@collab/services/project-connections.js";

const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-9222-222222222222";

/**
 * A Hocuspocus whose documents each hold one connection that records how it
 * was closed.
 * @param docNames - Documents to load.
 * @returns The fake server and the closes, in order.
 */
function makeHocuspocus(docNames: string[]): {
  hocuspocus: Hocuspocus;
  closed: Array<{ docName: string; code: number; reason: string }>;
} {
  const closed: Array<{ docName: string; code: number; reason: string }> = [];
  const documents = new Map<string, { connections: Map<unknown, unknown> }>();
  for (const docName of docNames) {
    const connections = new Map<unknown, unknown>();
    connections.set(
      {
        close: ({ code, reason }: { code: number; reason: string }) => closed.push({ docName, code, reason }),
      },
      { clients: new Set<number>() },
    );
    documents.set(docName, { connections });
  }
  return { hocuspocus: { documents } as unknown as Hocuspocus, closed };
}

describe("closeProjectConnections", () => {
  it("closes every document of the project and no other project", () => {
    const { hocuspocus, closed } = makeHocuspocus([
      `project-${PID}/meta`,
      `project-${PID}/canvas-${OTHER}`,
      `project-${OTHER}/meta`,
    ]);

    closeProjectConnections(hocuspocus, PID, "archived");

    expect(closed.map((c) => c.docName)).toEqual([`project-${PID}/meta`, `project-${PID}/canvas-${OTHER}`]);
  });

  it.each([
    ["content-updated", 4406, "Project content updated"],
    ["archived", 4407, "Project archived"],
    ["restored", 4408, "Project restored"],
  ] as const)("closes with the frame the client re-authenticates on for %s", (reason, code, text) => {
    const { hocuspocus, closed } = makeHocuspocus([`project-${PID}/meta`]);

    closeProjectConnections(hocuspocus, PID, reason);

    expect(closed).toEqual([{ docName: `project-${PID}/meta`, code, reason: text }]);
  });
});
