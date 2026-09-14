// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Opening the grant and the node's row as one step (#207, design I3).
 *
 * Every grant that names a node has exactly one row in `node_tasks`, and the
 * two find each other by the storage key and by nothing else. Breaking that is
 * silent: settlement looks the row up by the grant's key, finds none, and the
 * node shows a task that runs until a harvest calls it expired.
 *
 * Both lanes that hand bytes to the ingest Worker come through here, so the
 * order and the shared key are structural rather than a comment in each.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const issueUploadGrant = vi.fn(async () => ({
  key: "image/2026-09-14/1_abc.png",
  studioId: "studio-1",
}));
const open = vi.fn(async () => ({
  id: "task-row-1",
  counts: { running: 1, done: 0, failed: 0, expired: 0 },
}));
const emit = vi.fn();

vi.mock("@breatic/domain", () => ({
  uploadGrantService: { issueUploadGrant },
  nodeTaskService: { open },
  emitNodeTaskCounts: emit,
}));

vi.mock("@breatic/core", () => ({
  getStreamRedis: () => ({}),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { openUpload } = await import("@server/modules/asset/upload-opening.js");

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SPACE = "33333333-3333-4333-8333-333333333333";
const NODE = "44444444-4444-4444-8444-444444444444";
const USER = "22222222-2222-4222-8222-222222222222";

/** The grant input a lane hands over, with the node context a case wants. */
function grantFor(
  context: Record<string, string | null> = { nodeId: NODE, spaceId: SPACE },
): Parameters<typeof openUpload>[0] {
  return {
    projectId: PROJECT,
    actingUserId: USER,
    declaredSize: 1024,
    taskType: "image",
    ext: ".png",
    expiresAt: new Date(0),
    context,
  };
}

const TASK = { budgetMs: 60_000, label: "cat.png" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("opening an upload that lands on a node", () => {
  it("opens the row on the key the grant just returned", async () => {
    await openUpload(grantFor(), TASK);

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: "image/2026-09-14/1_abc.png" }),
    );
  });

  it("opens the grant before the row, which has no key to be found by until then", async () => {
    await openUpload(grantFor(), TASK);

    expect(issueUploadGrant.mock.invocationCallOrder[0]).toBeLessThan(
      open.mock.invocationCallOrder[0]!,
    );
  });

  it("opens the row on the node the grant names, with what the lane asked for", async () => {
    await openUpload(grantFor(), TASK);

    expect(open).toHaveBeenCalledWith({
      projectId: PROJECT,
      spaceId: SPACE,
      nodeId: NODE,
      kind: "upload",
      startedByUserId: USER,
      budgetMs: 60_000,
      label: "cat.png",
      storageKey: "image/2026-09-14/1_abc.png",
    });
  });

  it("publishes the node's counts, and hands the row's id back", async () => {
    const opened = await openUpload(grantFor(), TASK);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(opened).toEqual({
      key: "image/2026-09-14/1_abc.png",
      studioId: "studio-1",
      taskId: "task-row-1",
    });
  });
});

describe("opening an upload that lands on no node", () => {
  // A focus crop. The counts live in a node's corner and there is no corner,
  // so settlement has nothing to settle and opens nothing to be settled.
  it("opens the grant alone, with no row and no counts", async () => {
    const opened = await openUpload(grantFor({ nodeId: null, spaceId: null }), TASK);

    expect(issueUploadGrant).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(opened.taskId).toBeUndefined();
  });

  it("opens no row when the grant names only half of where it would go", async () => {
    // A row needs both: the space is what names the document the counts are
    // published on, so a node without one would open a row nobody ever sees.
    await openUpload(grantFor({ nodeId: NODE, spaceId: null }), TASK);
    await openUpload(grantFor({ nodeId: null, spaceId: SPACE }), TASK);

    expect(open).not.toHaveBeenCalled();
  });
});
