// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";

import {
  BODY_REGISTRATION_ORIGIN,
  documentBodyRecords,
  documentBodySource,
  DOCUMENT_BODY_FORMAT,
  DOCUMENT_BODY_FORMAT_VERSION,
  registerDocumentBodyRecords,
} from "@shared/document-body-records.js";
import { DocumentBodyFormatError } from "@shared/document-body-records-schema.js";
import { readBodyTree } from "@shared/document-body-tree.js";
import { convertLegacyTables } from "@shared/document-body-legacy-tables.js";
import { identifyImportBlocks, importIdentity, importNativeIdentity } from "@shared/document-body-import-xml.js";
import { planCurrentDocumentBody, type BodyImportPlan } from "@shared/document-body-import-plan.js";
import type { DocumentBodyImportResult } from "@shared/document-body-import-types.js";

/**
 * Publishes only a fully planned base snapshot, with the format marker written last.
 * @param doc - The isolated loading document receiving the new base records.
 * @param plan - Complete previously validated descriptors and native runs.
 * @throws {DocumentBodyFormatError} If immutable registration conflicts.
 * @throws {Error} If a native observer rejects the publication.
 */
function publishImport(doc: Y.Doc, plan: BodyImportPlan): void {
  doc.transact(() => {
    registerDocumentBodyRecords(doc, plan.registration);
    for (const run of plan.runs) {
      const text = documentBodySource(doc, run.source);
      if (typeof run.insert === "string") text.insert(text.length - 1, run.insert, run.attributes);
      else text.insertEmbed(text.length - 1, run.insert, run.attributes);
    }
    const metadata = documentBodyRecords(doc).metadata;
    metadata.set("seedRoot", plan.root);
    metadata.set("version", DOCUMENT_BODY_FORMAT_VERSION);
    metadata.set("format", DOCUMENT_BODY_FORMAT);
  }, BODY_REGISTRATION_ORIGIN);
}

/**
 * Converts only the current stored XML snapshot inside an isolated loading document.
 *
 * Callers retain ownership of the repository row lock and commit. Original XML
 * and comments remain untouched; temporary normalization never reaches output.
 * Complete records are authoritative even when the retained XML is stale.
 * @param doc - A loading document decoded from the actual current stored bytes.
 * @param documentName - The immutable owning document name used for deterministic IDs.
 * @returns Whether complete records were newly prepared and must be persisted.
 * @throws {DocumentBodyFormatError} If the current format, dependencies or XML payload are invalid.
 */
export function importCurrentDocumentBody(doc: Y.Doc, documentName: string): DocumentBodyImportResult {
  let temporary: Y.Doc | undefined;
  try {
    if (documentName === "") throw new DocumentBodyFormatError("A stored body import requires document ownership");
    const current = readBodyTree(doc);
    if (current.status === "ready") return { status: "ready", changed: false };
    if (current.status === "pending") throw new DocumentBodyFormatError(`Stored body dependencies are incomplete:${current.missing.join(",")}`);
    const roots = documentBodyRecords(doc);
    const registries = [roots.metadata, roots.records, roots.sources, roots.facts, roots.groups, roots.enabled, roots.contexts];
    if (registries.some((root) => root.size > 0) || [...doc.share.keys()].some((key) => key.startsWith("body:inline:"))) throw new DocumentBodyFormatError("An unmarked stored body contains partial records");

    temporary = new Y.Doc({ gc: false });
    Y.applyUpdate(temporary, Y.encodeStateAsUpdate(doc));
    const identities = identifyImportBlocks(temporary, documentName);
    convertLegacyTables(temporary, (node, role) => importIdentity(identities, role, importNativeIdentity(node)));
    const plan = planCurrentDocumentBody(temporary, identities);
    publishImport(temporary, plan);
    const validated = readBodyTree(temporary);
    if (validated.status !== "ready") throw new DocumentBodyFormatError("Current snapshot did not produce complete body records");
    publishImport(doc, plan);
    return { status: "ready", changed: true };
  } catch (error) {
    if (error instanceof DocumentBodyFormatError) throw error;
    throw new DocumentBodyFormatError("Cannot prepare the current stored body snapshot", error);
  } finally {
    temporary?.destroy();
  }
}
