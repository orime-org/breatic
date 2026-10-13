// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the project-lifecycle consumer does with one command (inner#1497 §6.2).
 *
 * The consumer group hands each command to one collab instance, so that
 * instance does the part that happens once — copying a duplicate's documents —
 * and then asks every instance, through the project control channel, to close
 * its own connections to the project:
 *   - project:duplicated → copy the source's docs, then close the NEW
 *     project's connections so a client that raced in reloads the copy;
 *   - project:archived / project:restored → close every connection of the
 *     project with the reason the client re-authenticates on;
 *   - an unknown command does nothing, so one bad event can't block the stream.
 *
 * The yjs repo and the publisher are stand-ins.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  });

  it("project:duplicated copies the source, then asks every instance to close the NEW project's connections", async () => {
    await handleLifecycleEvent({ type: "project:duplicated", sourceId: PID, newId: NEW_PID, ts: 1 }, publish);

    expect(duplicateByProjectPrefixMock).toHaveBeenCalledWith(PID, NEW_PID);
    expect(order).toEqual(["copy", `publish:${NEW_PID}:content-updated`]);
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

  it("propagates a copy error without closing anything, so the consumer retries", async () => {
    duplicateByProjectPrefixMock.mockRejectedValue(new Error("yjs db down"));

    await expect(
      handleLifecycleEvent({ type: "project:duplicated", sourceId: PID, newId: NEW_PID, ts: 1 }, publish),
    ).rejects.toThrow("yjs db down");
    expect(publish).not.toHaveBeenCalled();
  });

  it("propagates a publish error, so the command is retried rather than acknowledged", async () => {
    publish.mockRejectedValueOnce(new Error("redis down"));

    await expect(handleLifecycleEvent({ type: "project:archived", projectId: PID, ts: 1 }, publish)).rejects.toThrow(
      "redis down",
    );
  });
});
