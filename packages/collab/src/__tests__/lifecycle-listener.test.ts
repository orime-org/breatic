// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the project-lifecycle consumer's dispatch + kick.
 *
 * Pins the critical-path routing the outbox stream drives:
 *   - project:deleted   → soft-delete the project's yjs docs + close
 *     ALL of its connections (a stale tab can't keep writing) with a
 *     terminal close code (4404, not members-sync's reconnect 4403);
 *   - project:duplicated → copy the source's docs + close the NEW
 *     project's connections (4406) so a client that raced in and
 *     lazy-seeded reloads the copied content — the SOURCE is untouched;
 *   - an unknown command is skipped (no repo call, no kick) so one bad
 *     event can't block the stream.
 *
 * The yjs repo is mocked (no DB); Hocuspocus is a minimal fake exposing
 * the `documents` → `connections` shape the kick walks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";

// `createLogger` now comes from `@breatic/core` (the unified logger). Spread
// the real core barrel (so `lifecycleStreamKey` etc. stay intact) and
// override only `createLogger` with a no-op spy factory.
vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const { softDeleteByProjectPrefixMock, duplicateByProjectPrefixMock } =
  vi.hoisted(() => ({
    softDeleteByProjectPrefixMock: vi.fn(),
    duplicateByProjectPrefixMock: vi.fn(),
  }));

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  softDeleteByProjectPrefix: softDeleteByProjectPrefixMock,
  duplicateByProjectPrefix: duplicateByProjectPrefixMock,
}));

import { handleLifecycleEvent } from "@collab/services/lifecycle-listener.js";

const PID = "11111111-1111-4111-8111-111111111111";
const NEW_PID = "22222222-2222-4222-9222-222222222222";

interface ClosedFrame {
  docName: string;
  code: number;
}

/**
 * Build a minimal fake Hocuspocus whose `documents` map carries one
 * connection per doc name; closing records the (docName, code).
 * @param docNames - Doc names to populate with a single connection each
 * @returns The fake hocuspocus + the list closures are recorded into
 */
function makeHocuspocus(docNames: string[]): {
  hocuspocus: Hocuspocus;
  closed: ClosedFrame[];
} {
  const closed: ClosedFrame[] = [];
  const documents = new Map<string, { connections: Map<string, unknown> }>();
  for (const docName of docNames) {
    const connections = new Map<string, unknown>();
    connections.set("conn-1", {
      connection: {
        context: { user: { id: "u1" } },
        close: ({ code }: { code: number }) => closed.push({ docName, code }),
      },
    });
    documents.set(docName, { connections });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { hocuspocus: { documents } as any, closed };
}

describe("handleLifecycleEvent", () => {
  beforeEach(() => {
    softDeleteByProjectPrefixMock.mockReset().mockResolvedValue(undefined);
    duplicateByProjectPrefixMock.mockReset().mockResolvedValue(undefined);
  });

  it("project:deleted soft-deletes the project + closes ALL its connections (4404)", async () => {
    const { hocuspocus, closed } = makeHocuspocus([
      `project-${PID}/meta`,
      `project-${PID}/canvas-${NEW_PID}`,
      `project-${NEW_PID}/meta`, // another project — must be untouched
    ]);

    await handleLifecycleEvent(hocuspocus, {
      type: "project:deleted",
      projectId: PID,
      ts: 1,
    });

    expect(softDeleteByProjectPrefixMock).toHaveBeenCalledWith(PID);
    // Both of PID's docs closed with 4404; the other project untouched.
    expect(closed).toHaveLength(2);
    expect(closed.every((c) => c.code === 4404)).toBe(true);
    expect(closed.every((c) => c.docName.startsWith(`project-${PID}/`))).toBe(true);
  });

  it("project:duplicated copies the source + closes the NEW project's connections (4406), source untouched", async () => {
    const { hocuspocus, closed } = makeHocuspocus([
      `project-${PID}/meta`, // source — must NOT be kicked
      `project-${NEW_PID}/meta`,
    ]);

    await handleLifecycleEvent(hocuspocus, {
      type: "project:duplicated",
      sourceId: PID,
      newId: NEW_PID,
      ts: 1,
    });

    expect(duplicateByProjectPrefixMock).toHaveBeenCalledWith(PID, NEW_PID);
    expect(closed).toEqual([
      { docName: `project-${NEW_PID}/meta`, code: 4406 },
    ]);
  });

  it("skips an unknown command (no repo call, no kick)", async () => {
    const { hocuspocus, closed } = makeHocuspocus([`project-${PID}/meta`]);

    await handleLifecycleEvent(hocuspocus, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: "project:unknown" as any,
      projectId: PID,
      ts: 1,
    });

    expect(softDeleteByProjectPrefixMock).not.toHaveBeenCalled();
    expect(duplicateByProjectPrefixMock).not.toHaveBeenCalled();
    expect(closed).toHaveLength(0);
  });

  it("propagates a repo error so the stream consumer retries (no cursor advance)", async () => {
    softDeleteByProjectPrefixMock.mockRejectedValue(new Error("yjs db down"));
    const { hocuspocus } = makeHocuspocus([`project-${PID}/meta`]);

    await expect(
      handleLifecycleEvent(hocuspocus, {
        type: "project:deleted",
        projectId: PID,
        ts: 1,
      }),
    ).rejects.toThrow("yjs db down");
  });
});
