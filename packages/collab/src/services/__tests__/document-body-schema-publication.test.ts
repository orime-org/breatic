// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  DOCUMENT_BODY_FORMAT,
  DOCUMENT_BODY_FORMAT_VERSION,
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  documentSchemaVersion,
} from "@breatic/shared";

import {
  keepDocumentSchemaPublished,
  publishDocumentSchema,
} from "@collab/services/document-schema-publisher.js";

const docs: Y.Doc[] = [];
const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const doc of docs.splice(0)) doc.destroy();
});

/** Creates one independently owned project metadata document. @returns The metadata document. @throws {never} */
function metadata(): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

/**
 * Reads the complete declaration published by the real server-side function.
 * @param doc - The project metadata document.
 * @returns The current schema publication.
 * @throws {never}
 */
function published(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap(DOCUMENT_SCHEMA_META_KEY).toJSON();
}

describe("document body format schema publication", () => {
  it("publishes body format and version beside the vocabulary digest", () => {
    const doc = metadata();

    expect(publishDocumentSchema(doc)).toBe(true);

    expect(published(doc)).toMatchObject({
      version: DOCUMENT_SCHEMA_VERSION,
      publishedAt: DOCUMENT_SCHEMA.publishedAt,
      bodyFormat: "breatic.document.records",
      bodyFormatVersion: 1,
      nodes: DOCUMENT_SCHEMA.nodes,
      marks: DOCUMENT_SCHEMA.marks,
      content: DOCUMENT_SCHEMA.content,
    });
    expect(published(doc).bodyFormat).toBe(DOCUMENT_BODY_FORMAT);
    expect(published(doc).bodyFormatVersion).toBe(DOCUMENT_BODY_FORMAT_VERSION);
  });

  it("keeps a repeated complete publication unchanged", () => {
    const doc = metadata();
    const updates = vi.fn();
    doc.on("update", updates);
    expect(publishDocumentSchema(doc)).toBe(true);
    const bytes = Y.encodeStateAsUpdate(doc);

    expect(publishDocumentSchema(doc)).toBe(false);

    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(published(doc).bodyFormat).toBe("breatic.document.records");
    expect(published(doc).bodyFormatVersion).toBe(1);
  });

  it("republishes the body declaration after an older build publishes a different format", () => {
    const doc = metadata();
    const writes = vi.fn();
    releases.push(keepDocumentSchemaPublished(doc, { force: false }, writes));
    const older = {
      ...DOCUMENT_SCHEMA,
      publishedAt: "2020-01-01T00:00:00Z",
      bodyFormat: "breatic.document.xml",
      bodyFormatVersion: 1,
    };

    doc.transact(() => {
      const map = doc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set("version", documentSchemaVersion(older));
      map.set("publishedAt", older.publishedAt);
      map.set("bodyFormat", older.bodyFormat);
      map.set("bodyFormatVersion", older.bodyFormatVersion);
    }, "older-build");

    expect(writes).toHaveBeenCalledTimes(2);
    expect(published(doc)).toMatchObject({
      version: DOCUMENT_SCHEMA_VERSION,
      publishedAt: DOCUMENT_SCHEMA.publishedAt,
      bodyFormat: "breatic.document.records",
      bodyFormatVersion: 1,
    });
  });
});
