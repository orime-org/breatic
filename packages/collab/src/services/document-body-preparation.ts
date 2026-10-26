// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import { createLogger } from "@breatic/core";
import { DocumentBodyFormatError, importCurrentDocumentBody } from "@breatic/shared";
import { prepareDocData } from "@collab/services/yjs-documents.repo.js";

const logger = createLogger("document-body-preparation");

/**
 * Prepares one locked snapshot without mutating a live loading document.
 * @param current - The latest bytes read under the repository's row lock.
 * @param documentName - The document ownership used for stable imported IDs.
 * @returns Original bytes for complete records, or the complete prepared update.
 * @throws {DocumentBodyFormatError} If the update or stored body is invalid.
 * @throws {Error} If native encoding or preparation fails.
 */
function prepareStoredBody(current: Uint8Array, documentName: string): Uint8Array {
  const document = new Y.Doc({ gc: false });
  try {
    try {
      Y.applyUpdate(document, current);
    } catch (error) {
      throw new DocumentBodyFormatError("Invalid stored document update", error);
    }
    const result = importCurrentDocumentBody(document, documentName);
    return result.changed ? Y.encodeStateAsUpdate(document) : current;
  } finally {
    document.destroy();
  }
}

/**
 * Commits a complete document body before persistence publishes its load bytes.
 * @param documentName - The current document Space's immutable stored name.
 * @returns Committed ready bytes, or null when the content row is absent.
 * @throws {DocumentBodyFormatError} If the current snapshot cannot be prepared.
 * @throws {Error} If reading, preparing, writing or committing fails.
 */
export async function prepareDocumentBodyForLoad(documentName: string): Promise<Uint8Array | null> {
  try {
    return await prepareDocData(documentName, (current) => prepareStoredBody(current, documentName));
  } catch (err) {
    logger.error({ err, documentName, reason: "document_body_prepare_failed" }, "document_body_prepare_failed");
    throw err;
  }
}
