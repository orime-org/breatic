// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The selected-version check's refusal copy (frames-split design §5.5 界面状态 row): a request naming a version that is no
 * longer the selected one of the same source says the video was updated when the caller asks for that copy (the focus
 * crop); a different source, and every caller that does not ask, says the file cannot be processed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as core from "@breatic/core";
import type * as shared from "@breatic/shared";
import type { MiniToolsConfig } from "@breatic/core";
import type { MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import { selectedToolInput } from "@domain/mini-tool/selected-tool-input.js";

const outside = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest, t: (key: string): string => key }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), env: { INGEST_BASE_URL: "https://ingest.example.test", INGEST_SHARED_SECRET: "secret" } }));

const HASH = "a".repeat(64);
const REF = { toolInputId: "b".repeat(64), planSha256: "c".repeat(64) };
const binding = { contentHash: HASH } as unknown as MiniToolSourceBinding;
const config = { presentation: { policy_version: 1 } } as unknown as MiniToolsConfig;

/**
 * Seed the selected version the ingest read answers with.
 * @param selected - Its fields, or null for no selected version.
 * @returns Nothing.
 */
function select(selected: Record<string, unknown> | null): void {
  outside.ingest.mockResolvedValue({ presentation: selected });
}

describe("selectedToolInput refusal copy (§5.5 界面状态)", () => {
  beforeEach(() => { outside.ingest.mockReset(); });

  it("returns the selected version when the request names it", async () => {
    const selected = { sourceFingerprint: HASH, ...REF };
    select(selected);
    await expect(selectedToolInput(REF, binding, "video/k.mp4", config)).resolves.toEqual(selected);
  });

  it.each([
    ["a different toolInputId", { sourceFingerprint: HASH, ...REF, toolInputId: "d".repeat(64) }],
    ["a different plan", { sourceFingerprint: HASH, ...REF, planSha256: "d".repeat(64) }],
    ["no selected version", null],
  ])("says presentationChanged for %s of the same source when the caller asks for it", async (_case, selected) => {
    select(selected);
    await expect(selectedToolInput(REF, binding, "video/k.mp4", config, "server.mini_tool.presentationChanged")).rejects.toThrow("server.mini_tool.presentationChanged");
  });

  it("says foreignSource for a version of another source even when the caller asks for presentationChanged", async () => {
    select({ sourceFingerprint: "e".repeat(64), ...REF, toolInputId: "d".repeat(64) });
    await expect(selectedToolInput(REF, binding, "video/k.mp4", config, "server.mini_tool.presentationChanged")).rejects.toThrow("server.mini_tool.foreignSource");
  });

  it("says foreignSource for every mismatch when the caller does not ask (extract frames, split, scene detection)", async () => {
    select({ sourceFingerprint: HASH, ...REF, toolInputId: "d".repeat(64) });
    await expect(selectedToolInput(REF, binding, "video/k.mp4", config)).rejects.toThrow("server.mini_tool.foreignSource");
  });
});
