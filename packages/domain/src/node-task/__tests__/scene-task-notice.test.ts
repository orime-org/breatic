// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D generation whose optional rig step failed still ends done, with its
 * generated model, and says so on its row (inner#1692, design 6.2 and 7.1).
 *
 * The run stores `notice: 'rig_failed'` on its task result; `generationOutcome`
 * reads it from there, and `settle` writes it to the row both when it moves a
 * running row and when it attaches a late result to an expired one.
 *
 * Invariant: the outcome carries `notice: 'rig_failed'` exactly when the
 * stored result says `rig_failed` and the run produced a model; every other
 * done outcome carries `notice: null`, and a run without a model fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

const settleRunning = vi.fn();
const attachAsset = vi.fn();

vi.mock("@domain/node-task/node-task.repo.js", () => ({ settleRunning, attachAsset }));
vi.mock("@domain/task/task.repo.js", () => ({ findLiveTasksByIds: vi.fn() }));

const { generationOutcome, settle } = await import("@domain/node-task/scene-task.service.js");

/** A Space-level generation row as the repository returns it. */
const ROW = {
  id: "row-1",
  projectId: "project-1",
  spaceId: "space-1",
  nodeId: null,
  kind: "generation",
  action: "generate",
  status: "running",
  startedByUserId: "user-1",
  startedAt: new Date(),
  settledAt: null,
  budgetMs: 7_200_000,
  label: "a knight",
  errorMessage: null,
  nodeHistoryId: null,
  assetId: null,
} as unknown as Parameters<typeof settle>[0];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generationOutcome with a stored notice (inner#1692)", () => {
  const outputs = [{ url: "https://cdn/model.glb", asset_id: "asset-1" }];

  it("ends done with the model and the notice when the stored result says the rig failed", () => {
    expect(generationOutcome(outputs, { outputs, notice: "rig_failed" })).toEqual({ outcome: "done", assetId: "asset-1", notice: "rig_failed" });
  });

  it("ends done with no notice when the result carries none, or when no result is given", () => {
    expect(generationOutcome(outputs, { outputs })).toEqual({ outcome: "done", assetId: "asset-1", notice: null });
    expect(generationOutcome(outputs, null)).toEqual({ outcome: "done", assetId: "asset-1", notice: null });
    expect(generationOutcome(outputs)).toEqual({ outcome: "done", assetId: "asset-1", notice: null });
  });

  it("fails a run that produced no model, whatever notice it stored", () => {
    expect(generationOutcome([], { outputs: [], notice: "rig_failed" })).toEqual({ outcome: "failed", errorMessage: "no_result" });
  });

  it("carries rig_failed exactly when the stored result says so (property)", () => {
    const notice = fc.oneof(fc.constant("rig_failed"), fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined), fc.boolean());
    const assetId = fc.oneof(fc.uuid(), fc.constant(undefined), fc.constant(null), fc.integer());
    fc.assert(
      fc.property(assetId, notice, fc.boolean(), (asset, given, withResult) => {
        const stored = [{ url: "https://cdn/model.glb", asset_id: asset }];
        const result = withResult ? { outputs: stored, notice: given } : undefined;
        const outcome = generationOutcome(stored, result);
        if (typeof asset !== "string") {
          expect(outcome).toEqual({ outcome: "failed", errorMessage: "no_result" });
          return;
        }
        expect(outcome).toEqual({
          outcome: "done",
          assetId: asset,
          notice: withResult && given === "rig_failed" ? "rig_failed" : null,
        });
      }),
    );
  });
});

describe("settle with a notice (inner#1692)", () => {
  it("writes the notice with the model when it moves a running row to done", async () => {
    settleRunning.mockResolvedValue(true);

    const settled = await settle(ROW, { outcome: "done", assetId: "asset-1", notice: "rig_failed" });

    expect(settled).toMatchObject({ applied: true, assetWritten: true });
    expect(settleRunning).toHaveBeenCalledExactlyOnceWith("row-1", "done", expect.objectContaining({ assetId: "asset-1", notice: "rig_failed" }));
    expect(attachAsset).not.toHaveBeenCalled();
  });

  it("writes the notice with the model it attaches to a row that already expired", async () => {
    settleRunning.mockResolvedValue(false);
    attachAsset.mockResolvedValue(true);

    const settled = await settle(ROW, { outcome: "done", assetId: "asset-1", notice: "rig_failed" });

    expect(settled).toMatchObject({ applied: false, assetWritten: true });
    expect(attachAsset).toHaveBeenCalledExactlyOnceWith("row-1", "asset-1", "rig_failed");
  });

  it("writes a null notice for a model that was rigged or never asked to be", async () => {
    settleRunning.mockResolvedValue(false);
    attachAsset.mockResolvedValue(false);

    await settle(ROW, { outcome: "done", assetId: "asset-1", notice: null });

    expect(settleRunning).toHaveBeenCalledExactlyOnceWith("row-1", "done", expect.objectContaining({ assetId: "asset-1", notice: null }));
    expect(attachAsset).toHaveBeenCalledExactlyOnceWith("row-1", "asset-1", null);
  });
});
