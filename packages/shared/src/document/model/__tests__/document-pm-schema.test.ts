// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ProseMirror schema collab builds to run external-agent document commands
 * (breatic#1488 §11.1) must match `DOCUMENT_SCHEMA` item by item, including the
 * marks extensions bring in (the comment mark, `unsupportedMark`): the
 * document format version check (§11.2) is only sound when both sides agree.
 *
 * Runs in Node with no DOM, the way collab runs it.
 */

import { describe, it, expect } from "vitest";

import { DOCUMENT_SCHEMA } from "@shared/document-schema.js";
import { documentPmSchema } from "@shared/document/model/document-pm-schema.js";

/**
 * Flattens one side of a schema (nodes or marks) to names and sorted attribute names.
 * @param types - The schema's nodes or marks.
 * @returns Name to attribute names.
 */
function flatten(types: Record<string, { spec: { attrs?: Record<string, unknown> } }>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(types).map(([name, type]) => [name, Object.keys(type.spec.attrs ?? {}).sort()]),
  );
}

describe("documentPmSchema", () => {
  it("builds in a process with no DOM", () => {
    expect(typeof globalThis.document).toBe("undefined");
    expect(Object.keys(documentPmSchema().nodes).length).toBeGreaterThan(0);
  });

  it("has the same nodes and attribute names as DOCUMENT_SCHEMA", () => {
    expect(flatten(documentPmSchema().nodes)).toEqual(
      Object.fromEntries(Object.entries(DOCUMENT_SCHEMA.nodes).map(([n, a]) => [n, [...a]])),
    );
  });

  it("has the same marks and attribute names as DOCUMENT_SCHEMA, the comment and fallback marks included", () => {
    const marks = flatten(documentPmSchema().marks);
    expect(marks).toEqual(Object.fromEntries(Object.entries(DOCUMENT_SCHEMA.marks).map(([n, a]) => [n, [...a]])));
    expect(Object.keys(marks)).toEqual(expect.arrayContaining(["comment", "unsupportedMark"]));
  });

  it("has the same content rule for every node", () => {
    const content = Object.fromEntries(
      Object.entries(documentPmSchema().nodes).map(([name, type]) => [name, String(type.spec.content ?? "")]),
    );
    expect(content).toEqual({ ...DOCUMENT_SCHEMA.content });
  });

  it("returns the same schema object on every call", () => {
    expect(documentPmSchema()).toBe(documentPmSchema());
  });
});
