// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  DOCUMENT_BODY_FORMAT,
  DOCUMENT_BODY_FORMAT_VERSION,
} from "@shared/document-body-records.js";
import {
  DOCUMENT_SCHEMA,
  documentSchemaDiffers,
  documentSchemaVersion,
  type DocumentSchema,
} from "@shared/document-schema.js";

type BodySchema = DocumentSchema & {
  readonly bodyFormat: string;
  readonly bodyFormatVersion: number;
};

/**
 * Holds vocabulary constant while varying its serialized body contract.
 * @param bodyFormat - The stored body format name.
 * @param bodyFormatVersion - The stored body format version.
 * @returns A complete schema declaration for a build.
 * @throws {never}
 */
function schema(
  bodyFormat: string = DOCUMENT_BODY_FORMAT,
  bodyFormatVersion: number = DOCUMENT_BODY_FORMAT_VERSION,
): BodySchema {
  return { ...DOCUMENT_SCHEMA, bodyFormat, bodyFormatVersion };
}

describe("document body format schema contract", () => {
  it("declares the records format and version used by the body codec", () => {
    const declaration: DocumentSchema & Partial<BodySchema> = DOCUMENT_SCHEMA;

    expect(declaration.bodyFormat).toBe("breatic.document.records");
    expect(declaration.bodyFormatVersion).toBe(1);
    expect(declaration.bodyFormat).toBe(DOCUMENT_BODY_FORMAT);
    expect(declaration.bodyFormatVersion).toBe(DOCUMENT_BODY_FORMAT_VERSION);
  });

  it("changes the digest when only the body format name changes", () => {
    const records = schema();
    const other = schema("breatic.document.other");

    expect(documentSchemaVersion(records)).not.toBe(documentSchemaVersion(other));
  });

  it("changes the digest when only the body format version changes", () => {
    const first = schema();
    const next = schema(DOCUMENT_BODY_FORMAT, 2);

    expect(documentSchemaVersion(first)).not.toBe(documentSchemaVersion(next));
  });

  it("distinguishes a vocabulary without a body declaration from the records format", () => {
    const { publishedAt, nodes, marks, content } = DOCUMENT_SCHEMA;
    const withoutBody: DocumentSchema = { publishedAt, nodes, marks, content };

    expect(documentSchemaVersion(withoutBody)).not.toBe(documentSchemaVersion(schema()));
  });

  it("keeps the digest independent of the publication timestamp", () => {
    const first = schema();
    const corrected = { ...first, publishedAt: "2030-01-01T00:00:00Z" };

    expect(documentSchemaVersion(corrected)).toBe(documentSchemaVersion(first));
  });

  it("keeps vocabulary ordering independent of the included body contract", () => {
    const first = schema();
    const reordered = {
      ...first,
      nodes: Object.fromEntries(Object.entries(first.nodes).reverse().map(([name, attrs]) => [name, [...attrs].reverse()])),
      marks: Object.fromEntries(Object.entries(first.marks).reverse().map(([name, attrs]) => [name, [...attrs].reverse()])),
      content: Object.fromEntries(Object.entries(first.content).reverse()),
    };

    expect(documentSchemaVersion(reordered)).toBe(documentSchemaVersion(first));
  });

  it.each([
    ["breatic.document.other", DOCUMENT_BODY_FORMAT_VERSION],
    [DOCUMENT_BODY_FORMAT, 2],
  ] as const)("detects a format-only mismatch for %s version %s", (bodyFormat, bodyFormatVersion) => {
    const mine = documentSchemaVersion(schema());
    const published = { version: documentSchemaVersion(schema(bodyFormat, bodyFormatVersion)) };

    expect(documentSchemaDiffers(mine, published)).toBe(true);
  });
});
