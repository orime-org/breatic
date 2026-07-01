// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { shouldTrackConnection } from "@collab/services/connection-tracking.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

describe("shouldTrackConnection (#1421 per-document cap tracking policy)", () => {
  it("tracks Space content docs (canvas / document / timeline)", () => {
    expect(shouldTrackConnection(`project-${PID}/canvas-${SID}`)).toBe(true);
    expect(shouldTrackConnection(`project-${PID}/document-${SID}`)).toBe(true);
    expect(shouldTrackConnection(`project-${PID}/timeline-${SID}`)).toBe(true);
  });

  it("does NOT track the meta doc — it is exempt from the cap", () => {
    expect(shouldTrackConnection(`project-${PID}/meta`)).toBe(false);
  });

  it("does NOT track non-project doc names (e.g. the healthz sentinel)", () => {
    expect(shouldTrackConnection("__healthz_probe__")).toBe(false);
    expect(shouldTrackConnection("random-doc-name")).toBe(false);
    // Obsolete pre-v10 single-doc form parses to null → not tracked.
    expect(shouldTrackConnection(`project-${PID}`)).toBe(false);
  });
});
