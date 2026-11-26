// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the project-lifecycle consumer does with one command (inner#1497 §6.2).
 *
 * The consumer group hands each command to one collab instance, so that
 * instance does the part that happens once — copying a duplicate's documents —
 * and then asks every instance, through the project control channel, to close
 * its own connections to the project:
 *   - project:duplicated → copy the source's docs, record the copy as
 *     completed on its Project row (inner#1706), then close the NEW project's
 *     connections; a command for a copy already completed copies nothing, so a
 *     redelivery never overwrites what the user has done in the copy since;
 *   - project:archived / project:restored → close every connection of the
 *     project with the reason the client re-authenticates on;
 *   - an unknown command does nothing, so one bad event can't block the stream.
 *
 * The yjs repo, the Project row reads and writes, and the publisher are stand-ins.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { isDuplicateCompletedMock, markDuplicateCompletedMock } = vi.hoisted(() => ({
  isDuplicateCompletedMock: vi.fn(),
  markDuplicateCompletedMock: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    projectsRepo: {
      ...(orig.projectsRepo as Record<string, unknown>),
      isDuplicateCompleted: isDuplicateCompletedMock,
      markDuplicateCompleted: markDuplicateCompletedMock,
    },
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const { duplicateByProjectPrefixMock } = vi.hoisted(() => ({
  duplicateByProjectPrefixMock: vi.fn(),
}));

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  duplicateByProjectPrefix: duplicateByProjectPrefixMock,
}));

import { handleLifecycleEvent } from "@collab/services/lifecycle-listener.js";

const PID = "11111111-1111-4111-8111-111111111111";
const NEW_PID = "22222222-2222-4222-9222-222222222222";

describe("handleLifecycleEvent", () => {
  const order: string[] = [];
  const publish = vi.fn(async (projectId: string, reason: string) => {
    order.push(`publish:${projectId}:${reason}`);
  });

  beforeEach(() => {
    order.length = 0;
    publish.mockClear();
    duplicateByProjectPrefixMock.mockReset().mockImplementation(async () => {
      order.push("copy");
    });
    isDuplicateCompletedMock.mockReset().mockResolvedValue(false);
    markDuplicateCompletedMock.mockReset().mockImplementation(async (projectId: string) => {
      order.push(`completed:${projectId}`);
    });
  });

  it("project:duplicated copies the source, records the copy as completed, then asks every instance to close the NEW project's connections", async () => {
    await handleLifecycleEvent({ type: "project:duplicated", sourceId: PID, newId: NEW_PID, ts: 1 }, publish);

    expect(isDuplicateCompletedMock).toHaveBeenCalledWith(NEW_PID);
    expect(duplicateByProjectPrefixMock).toHaveBeenCalledWith(PID, NEW_PID, expect.any(Function));
    expect(order).toEqual(["copy", `completed:${NEW_PID}`, `publish:${NEW_PID}:content-updated`]);
  });

  it("project:duplicated for a copy already completed copies nothing and records nothing", async () => {
    isDuplicateCompletedMock.mockResolvedValue(true);

    await handleLifecycleEvent({ type: "project:duplicated", sourceId: PID, newId: NEW_PID, ts: 1 }, publish);

    expect(isDuplicateCompletedMock).toHaveBeenCalledWith(NEW_PID);
    expect(duplicateByProjectPrefixMock).not.toHaveBeenCalled();
    expect(markDuplicateCompletedMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("propagates a failure to record the completion without closing anything, so the consumer retries", async () => {
    markDuplicateCompletedMock.mockRejectedValue(new Error("business db down"));

    await expect(
      handleLifecycleEvent({ type: "project:duplicated", sourceId: PID, newId: NEW_PID, ts: 1 }, publish),
    ).rejects.toThrow("business db down");
    expect(order).toEqual(["copy"]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("propagates a failure to read whether the copy is completed without copying, so the consumer retries", async () => {
    isDuplicateCompletedMock.mockRejectedValue(new Error("business db down"));

    await expect(
      handleLifecycleEvent({ type: "project:duplicated", sourceId: PID, newId: NEW_PID, ts: 1 }, publish),
    ).rejects.toThrow("business db down");
    expect(duplicateByProjectPrefixMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("project:archived asks every instance to close the project's connections", async () => {
    await handleLifecycleEvent({ type: "project:archived", projectId: PID, ts: 1 }, publish);

    expect(order).toEqual([`publish:${PID}:archived`]);
    expect(duplicateByProjectPrefixMock).not.toHaveBeenCalled();
  });

  it("project:restored asks every instance to close the project's connections with its own reason", async () => {
    await handleLifecycleEvent({ type: "project:restored", projectId: PID, ts: 1 }, publish);

    expect(order).toEqual([`publish:${PID}:restored`]);
  });

  it("does nothing for an unknown command", async () => {
    await handleLifecycleEvent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "project:unknown" as any, projectId: PID, ts: 1 },
      publish,
    );

    expect(order).toEqual([]);
  });

  it("propagates a copy error without recording completion or closing anything, so the consumer retries", async () => {
    duplicateByProjectPrefixMock.mockRejectedValue(new Error("yjs db down"));

    await expect(
      handleLifecycleEvent({ type: "project:duplicated", sourceId: PID, newId: NEW_PID, ts: 1 }, publish),
    ).rejects.toThrow("yjs db down");
    expect(markDuplicateCompletedMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("propagates a publish error, so the command is retried rather than acknowledged", async () => {
    publish.mockRejectedValueOnce(new Error("redis down"));

    await expect(handleLifecycleEvent({ type: "project:archived", projectId: PID, ts: 1 }, publish)).rejects.toThrow(
      "redis down",
    );
  });
});
