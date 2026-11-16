// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Stored Timeline clips become frame offsets on load (#1502): before #1502 a clip's transform held canvas-pixel
 * offsets, and a version 1 document may still hold them, as may a document an old page wrote to after it was
 * converted. Converting stores what reading already shows, so no layer moves, and marks the document version 2 so an
 * old page refuses it instead of listing its clips as damaged.
 */

import * as Y from "yjs";

import { env } from "@breatic/core";
import { timelineDocumentNeedsUpgrade, upgradeTimelineDocument } from "@breatic/shared/space-content";

import type { ConversionOnLoad } from "@collab/services/legacy-table-conversion.js";

/** The transaction origin of the conversion. */
export const LEGACY_TIMELINE_TRANSFORM_CONVERSION_ORIGIN = "timeline-transform-migrate";

/**
 * The lock key for one document's conversion.
 * @param documentName - The document's full name.
 * @returns The key.
 */
function conversionLockKey(documentName: string): string {
  return `${env.ENV}:collab:lock:timeline-transform-migrate:${documentName}`;
}

/**
 * Converts a loaded Timeline's pixel-offset clips and version, unless another instance is doing it or already did.
 * @param load - The document and what the conversion needs.
 * @returns How many clips this instance converted.
 * @throws {Error} Whatever taking the lock, reading the stored document or the conversion throws.
 */
export async function convertStoredTimelineTransformsOnLoad(load: ConversionOnLoad): Promise<number> {
  if (!timelineDocumentNeedsUpgrade(load.document)) return 0;
  if (!(await load.takeLock(conversionLockKey(load.documentName)))) return 0;
  const stored = await load.readStored();
  if (stored !== null) Y.applyUpdate(load.document, stored, LEGACY_TIMELINE_TRANSFORM_CONVERSION_ORIGIN);
  let converted = 0;
  load.document.transact(() => {
    converted = upgradeTimelineDocument(load.document);
  }, LEGACY_TIMELINE_TRANSFORM_CONVERSION_ORIGIN);
  return converted;
}
