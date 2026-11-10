// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from "vitest";

import {
  DOCUMENT_VERSION_NAME_MAX_CHARS,
  documentVersionListQuerySchema,
  documentVersionRenameSchema,
  documentVersionSaveSchema,
} from "@shared/schemas/api.js";

const ids = {
  project_id: "11111111-1111-4111-8111-111111111111",
  space_id: "22222222-2222-4222-8222-222222222222",
};
const body = { type: "doc", content: [{ type: "blockGroup", content: [] }] };

describe("documentVersionSaveSchema", () => {
  it("accepts a body with or without a name", () => {
    expect(documentVersionSaveSchema.parse({ ...ids, content: body, schema_version: "v1" }).name).toBeUndefined();
    expect(documentVersionSaveSchema.parse({ ...ids, content: body, schema_version: "v1", name: "Draft" }).name).toBe("Draft");
  });

  it("treats a blank name as no name", () => {
    expect(documentVersionSaveSchema.parse({ ...ids, content: body, schema_version: "v1", name: "   " }).name).toBeUndefined();
  });

  it("refuses a name past the shared ceiling", () => {
    const name = "x".repeat(DOCUMENT_VERSION_NAME_MAX_CHARS + 1);
    expect(documentVersionSaveSchema.safeParse({ ...ids, content: body, schema_version: "v1", name }).success).toBe(false);
    expect(documentVersionSaveSchema.safeParse({ ...ids, content: body, schema_version: "v1", name: name.slice(1) }).success).toBe(true);
  });

  it("takes only a ProseMirror document as content", () => {
    for (const content of [[], { type: "paragraph" }, "doc", null]) {
      expect(documentVersionSaveSchema.safeParse({ ...ids, content, schema_version: "v1" }).success).toBe(false);
    }
  });

  it("needs a schema version and both ids", () => {
    expect(documentVersionSaveSchema.safeParse({ ...ids, content: body }).success).toBe(false);
    expect(documentVersionSaveSchema.safeParse({ project_id: ids.project_id, content: body, schema_version: "v1" }).success).toBe(false);
  });
});

describe("documentVersionRenameSchema", () => {
  it("takes a name or null to clear it", () => {
    expect(documentVersionRenameSchema.parse({ ...ids, name: "Final" }).name).toBe("Final");
    expect(documentVersionRenameSchema.parse({ ...ids, name: null }).name).toBeNull();
    expect(documentVersionRenameSchema.parse({ ...ids, name: "  " }).name).toBeNull();
  });

  it("refuses a name past the shared ceiling", () => {
    expect(documentVersionRenameSchema.safeParse({ ...ids, name: "x".repeat(DOCUMENT_VERSION_NAME_MAX_CHARS + 1) }).success).toBe(false);
  });
});

describe("documentVersionListQuerySchema", () => {
  it("takes both ids and an optional cursor", () => {
    expect(documentVersionListQuerySchema.parse(ids).cursor).toBeUndefined();
    expect(documentVersionListQuerySchema.parse({ ...ids, cursor: "abc" }).cursor).toBe("abc");
    expect(documentVersionListQuerySchema.safeParse({ ...ids, cursor: "x".repeat(513) }).success).toBe(false);
  });
});
