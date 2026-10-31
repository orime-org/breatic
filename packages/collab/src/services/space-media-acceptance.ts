// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import { createLogger, projectAssetReferenceService } from "@breatic/core";
import { parseDocName } from "@breatic/shared";
import { readSpaceMediaReferences } from "@breatic/shared/space-content";

const logger = createLogger("space-media-acceptance");

/**
 * Accept semantic media from the exact bytes being loaded, saved or copied.
 *
 * Business relationships commit before the independent Yjs write. Unavailable
 * references remain in the original bytes; failures accepting valid references
 * propagate so the caller preserves its previous state and retries (inner#1707).
 * @param documentName - The actual content row, never a client-supplied target.
 * @param state - The captured bytes this operation will accept.
 * @throws {Error} When decoding or accepting registered references fails.
 */
export async function acceptSpaceMediaReferences(documentName: string, state: Uint8Array): Promise<void> {
  const parsed = parseDocName(documentName);
  if (parsed === null || parsed.kind === "meta") return;
  const snapshot = new Y.Doc();
  try {
    Y.applyUpdate(snapshot, state);
    const references = readSpaceMediaReferences(parsed.kind, snapshot);
    if (references.assetIds.length === 0 && references.urls.length === 0) return;
    const result = await projectAssetReferenceService.referenceRegisteredProjectMedia({ projectId: parsed.projectId, ...references });
    if (result.unavailable.length > 0) {
      const unavailable = result.unavailable.reduce<Record<string, number>>((counts, item) => {
        const key = `${item.kind}:${item.reason}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {});
      logger.debug({ documentName, unavailable }, "space_media_references_unavailable");
    }
  } finally {
    snapshot.destroy();
  }
}
