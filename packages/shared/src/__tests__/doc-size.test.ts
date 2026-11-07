// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `doc:size` push contract between collab and web, and the constants both
 * ends share (inner#1790 v2 spec S-01 to S-06).
 */

import { describe, expect, it } from "vitest";
import * as barrel from "@shared/index.js";
import { DOC_SIZE_EVENT_BYTES, DocSizeStatusSchema } from "@shared/doc-size.js";
import {
  COLLAB_DOCUMENT_TOO_LARGE_REASON,
  COLLAB_REAUTH_REASONS,
  isReauthCloseReason,
} from "@shared/collab-close-reasons.js";

const BASE = { type: "doc:size", bytes: 0, limit: 0, ceiling: 0, phase: "normal" } as const;

describe("DocSizeStatusSchema", () => {
  it("S-01 accepts a push with no limit, a full push at the ceiling and a warning push, unchanged", () => {
    const inputs = [
      BASE,
      { type: "doc:size", bytes: 10747904, limit: 10485760, ceiling: 10747904, phase: "full" },
      { type: "doc:size", bytes: 9437184, limit: 10485760, ceiling: 10747904, phase: "warning" },
    ];
    for (const input of inputs) expect(DocSizeStatusSchema.parse(input)).toEqual(input);
  });

  it("S-02 refuses a bad value in any field or a missing field", () => {
    const bad: Record<string, unknown>[] = [
      { ...BASE, bytes: -1 },
      { ...BASE, limit: 1.5 },
      { ...BASE, ceiling: "10" },
      { ...BASE, phase: "over_ceiling" },
      { ...BASE, phase: "resyncing" },
      { ...BASE, type: "doc:sizes" },
    ];
    const withoutCeiling: Record<string, unknown> = { ...BASE };
    delete withoutCeiling.ceiling;
    const withoutPhase: Record<string, unknown> = { ...BASE };
    delete withoutPhase.phase;
    for (const input of [...bad, withoutCeiling, withoutPhase]) {
      expect(DocSizeStatusSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("S-04 drops the v1 room fields a stale sender still adds", () => {
    const parsed = DocSizeStatusSchema.parse({ type: "doc:size", bytes: 5, limit: 10, ceiling: 12, phase: "normal", room: 3, overwriteRoom: 1 });
    expect(Object.keys(parsed).sort()).toEqual(["bytes", "ceiling", "limit", "phase", "type"]);
  });
});

describe("shared size constants and close reason", () => {
  it("S-03 counts 32 bytes for each split endpoint and beyond-clock range", () => {
    expect(DOC_SIZE_EVENT_BYTES).toBe(32);
  });

  it("S-05 the size refusal is its own close reason, outside the re-authentication set", () => {
    expect(COLLAB_DOCUMENT_TOO_LARGE_REASON).toBe("Document size limit reached");
    expect(Object.values(COLLAB_REAUTH_REASONS)).not.toContain(COLLAB_DOCUMENT_TOO_LARGE_REASON);
    expect(isReauthCloseReason(COLLAB_DOCUMENT_TOO_LARGE_REASON)).toBe(false);
  });

  it("S-06 the package entry exports the v2 contract and no longer the v1 delete minimum", () => {
    expect(barrel.DocSizeStatusSchema).toBeDefined();
    expect(barrel.DOC_SIZE_EVENT_BYTES).toBe(32);
    expect(typeof barrel.updateShape).toBe("function");
    expect(barrel.COLLAB_DOCUMENT_TOO_LARGE_REASON).toBe("Document size limit reached");
    expect("SPACE_DELETE_MIN_BYTES" in barrel).toBe(false);
  });

  it("S-07 the built entry other packages load exports updateShape", async () => {
    const dist = (await import("../../dist/index.js")) as Record<string, unknown>;
    expect(typeof dist.updateShape).toBe("function");
  });
});
