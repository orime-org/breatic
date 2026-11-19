// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";
import { VIEW_CAPTURE_REQUEST_SIGNAL, projectMetaDocName } from "@breatic/shared";

import { relayViewCaptureRequest } from "@collab/services/project-control-sync.js";

vi.mock("@breatic/core", async (real) => ({
  ...(await real<typeof import("@breatic/core")>()),
  getMcpConfig: () => ({ view_capture: { max_edge_px: 1568, max_bytes: 917504, timeout_ms: 8000 } }),
}));

const PROJECT = "11111111-1111-4111-8111-111111111111";

/**
 * A connection on a document, opened by one user.
 * @param userId - Whose.
 * @returns The connection and what it was sent.
 */
function connection(userId: string): { context: { user: { id: string } }; sendStateless: ReturnType<typeof vi.fn> } {
  return { context: { user: { id: userId } }, sendStateless: vi.fn() };
}

describe("relayViewCaptureRequest (breatic#1488 §19.1)", () => {
  it("sends the capture request to the owner's meta connections only", () => {
    const ownerTab = connection("owner");
    const ownerOtherTab = connection("owner");
    const colleague = connection("colleague");
    const ownerOnCanvas = connection("owner");
    const hocuspocus = {
      documents: new Map([
        [projectMetaDocName(PROJECT), { connections: new Map([[ownerTab, {}], [ownerOtherTab, {}], [colleague, {}]]) }],
        [`project-${PROJECT}/canvas-22222222-2222-4222-8222-222222222222`, { connections: new Map([[ownerOnCanvas, {}]]) }],
      ]),
    } as unknown as Hocuspocus;
    relayViewCaptureRequest(hocuspocus, { type: "project-view-capture:requested", projectId: PROJECT, userId: "owner", requestId: "r1", ts: 1 });
    // The request carries the limits the browser captures within.
    const signal = JSON.stringify({ t: VIEW_CAPTURE_REQUEST_SIGNAL, requestId: "r1", userId: "owner", maxEdgePx: 1568, maxBytes: 917504 });
    expect(ownerTab.sendStateless).toHaveBeenCalledWith(signal);
    expect(ownerOtherTab.sendStateless).toHaveBeenCalledWith(signal);
    expect(colleague.sendStateless).not.toHaveBeenCalled();
    expect(ownerOnCanvas.sendStateless).not.toHaveBeenCalled();
  });

  it("does nothing on an instance that does not hold the project's meta document", () => {
    expect(() =>
      relayViewCaptureRequest({ documents: new Map() } as unknown as Hocuspocus, {
        type: "project-view-capture:requested",
        projectId: PROJECT,
        userId: "owner",
        requestId: "r1",
        ts: 1,
      }),
    ).not.toThrow();
  });
});
