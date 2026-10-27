// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoSourceLedgerCompanion, PhysicalVideoProbe, MatroskaPhysicalVideoProbe } from "@shared/upload/video-source-ledger-types.js";
import type { IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";

/** Already admitted source identity and frozen pure-planning ceilings. */
interface SourceLedgerAssemblyBase {
  sourceFingerprint: string;
  attempt: { jobId: string; deadlineAt: number };
  limits: { maxPhysicalFrames: number; maxOccurrences: number };
}
/** Complete same-source bounded reader/physical facts, not an IO request. */
export type VideoSourceLedgerAssemblyInput = SourceLedgerAssemblyBase & ({
  kind: "iso_bmff";
  metadata: IsoBmffMetadata;
  physical: PhysicalVideoProbe;
} | {
  kind: "matroska";
  metadata: MatroskaMetadata;
  physical: MatroskaPhysicalVideoProbe;
});

/**
 * Assemble the complete source companion by reusing the existing pure format owners.
 * @param input - Accepted immutable identity, original facts and mandatory limits.
 * @throws {Error} Until the independently specified pure assembly is implemented.
 */
export function assembleVideoSourceLedger(input: VideoSourceLedgerAssemblyInput): VideoSourceLedgerCompanion {
  void input;
  throw Object.assign(new Error("Source ledger assembly is not implemented"), { code: "not_implemented" });
}
