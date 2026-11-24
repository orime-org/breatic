// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The 3D task row sweep (inner#2061 design 5.3): every 3D Space whose overdue rows the round expired is told once
 * through its document's task version, and one Space whose announcement fails is logged and does not stop the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const h = vi.hoisted(() => ({
  harvestExpiredScenes: vi.fn<() => Promise<{ projectId: string; spaceId: string }[]>>(),
  announceSpaceTasksChange: vi.fn<(docName: string) => Promise<void>>(),
  error: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    announceSpaceTasksChange: h.announceSpaceTasksChange,
    logger: { info: vi.fn(), warn: vi.fn(), error: h.error, debug: vi.fn() },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    sceneTaskService: { ...actual.sceneTaskService, harvestExpiredScenes: h.harvestExpiredScenes },
  };
});

import { sweepSceneTasks } from "@worker/handlers/scene-task-sweep.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.announceSpaceTasksChange.mockResolvedValue(undefined);
});

describe("sweepSceneTasks", () => {
  it("announces each 3D Space whose rows the round expired, once, by its document", async () => {
    h.harvestExpiredScenes.mockResolvedValue([
      { projectId: "p1", spaceId: "s1" },
      { projectId: "p2", spaceId: "s2" },
    ]);

    await sweepSceneTasks();

    expect(h.harvestExpiredScenes).toHaveBeenCalledTimes(1);
    expect(h.announceSpaceTasksChange.mock.calls).toEqual([["project-p1/3d-s1"], ["project-p2/3d-s2"]]);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("announces nothing when no row ran out", async () => {
    h.harvestExpiredScenes.mockResolvedValue([]);

    await sweepSceneTasks();

    expect(h.announceSpaceTasksChange).not.toHaveBeenCalled();
  });

  it("logs a Space whose announcement fails and still announces the others", async () => {
    h.harvestExpiredScenes.mockResolvedValue([
      { projectId: "p1", spaceId: "s1" },
      { projectId: "p2", spaceId: "s2" },
    ]);
    const err = new Error("stream unreachable");
    h.announceSpaceTasksChange.mockRejectedValueOnce(err);

    await expect(sweepSceneTasks()).resolves.toBeUndefined();

    expect(h.announceSpaceTasksChange.mock.calls).toEqual([["project-p1/3d-s1"], ["project-p2/3d-s2"]]);
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith({ err, projectId: "p1", spaceId: "s1" }, "scene_task_sweep_publish_failed");
  });

  it("throws when the overdue rows cannot be expired, so the round is logged as failed", async () => {
    h.harvestExpiredScenes.mockRejectedValue(new Error("database unreachable"));

    await expect(sweepSceneTasks()).rejects.toThrow("database unreachable");
    expect(h.announceSpaceTasksChange).not.toHaveBeenCalled();
  });
});
