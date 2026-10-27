// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";
import type { MatroskaPhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";
import type { OwnedVideoPresentation } from "@ingest/container/iso-bmff-presentation.js";

/**
 * Assemble complete rate-one Matroska occurrences from independently associated frames.
 * @throws {Error} Until the independently specified common schedule is implemented.
 */
export function assembleMatroskaVideoPresentation(metadata: MatroskaMetadata, physical: MatroskaPhysicalVideoProbe, maxOccurrences: number): OwnedVideoPresentation {
  void metadata; void physical; void maxOccurrences;
  throw Object.assign(new Error("Matroska video presentation is not implemented"), { code: "not_implemented" });
}
