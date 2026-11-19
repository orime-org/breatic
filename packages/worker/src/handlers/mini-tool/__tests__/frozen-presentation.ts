// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tool input an accepted analysis freezes (inner#1306 §90 E4-12): its presentation reference, the selected
 * version's ledger receipt and version id, as an execution freezes them. These handler tests never read the objects.
 */
const TOOL_INPUT = "e989392b50af768e7d1a42bdf29921f364c87e90bdb34ddc633209ffe22a19ec";
const PLAN = "bf04fa15ca5b369ad3012912dacce70ff0ec47c9779c5c1f87e461505e3c4ea1";

export const FROZEN_PRESENTATION = {
  presentationRef: { source: { toolInputId: TOOL_INPUT, planSha256: PLAN } },
  ledgerReceipts: { source: {
    schemaVersion: 2 as const, sourceFingerprint: "b".repeat(64), toolInputId: TOOL_INPUT, planSha256: PLAN, producerVersion: 2 as const,
    attempt: { jobId: "video-presentation:analysis-source", deadlineAt: 1900000000000 },
    url: `https://assets.test.invalid/original.mp4.video-source-ledger.${TOOL_INPUT}.json`, etag: "full-etag", size: 1229, sha256: "c".repeat(64), contentType: "application/json" as const,
    table: { url: `https://assets.test.invalid/original.mp4.video-presentation-table.${TOOL_INPUT}.json`, sha256: "d".repeat(64), size: 356, contentType: "application/json" as const, frameCount: 120 },
  } },
  versionIds: { source: "e".repeat(64) },
};
