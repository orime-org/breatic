// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the Hocuspocus persistence delegation.
 *
 * The persistence extension is a thin adapter: it maps Hocuspocus's
 * `{ documentName, state }` payloads onto the shared core
 * `yjsDocumentsRepo` (the single home for `yjs_documents` SQL). These
 * tests pin that mapping (documentName → name, state → data); the SQL
 * correctness itself — soft-delete filtering on fetch, resurrection on
 * upsert — is covered by the core repo's integration test against a
 * real Postgres.
 *
 * `@breatic/core` is mocked wholesale so the real barrel (and its
 * `ai`/otel transitive deps) stays out of vitest's ESM resolver.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchDocDataMock, upsertDocDataMock } = vi.hoisted(() => ({
  fetchDocDataMock: vi.fn(),
  upsertDocDataMock: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  yjsDocumentsRepo: {
    fetchDocData: fetchDocDataMock,
    upsertDocData: upsertDocDataMock,
  },
}));

import { fetchDoc, storeDoc } from "../services/persistence.js";

describe("collab persistence delegation", () => {
  beforeEach(() => {
    fetchDocDataMock.mockReset();
    upsertDocDataMock.mockReset();
  });

  it("fetchDoc returns the repo's stored bytes for the document name", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    fetchDocDataMock.mockResolvedValue(bytes);

    const out = await fetchDoc({ documentName: "project-p/canvas-s" });

    expect(fetchDocDataMock).toHaveBeenCalledWith("project-p/canvas-s");
    expect(out).toBe(bytes);
  });

  it("fetchDoc returns null when the repo has no live (non-soft-deleted) row", async () => {
    fetchDocDataMock.mockResolvedValue(null);
    expect(await fetchDoc({ documentName: "project-p/meta" })).toBeNull();
  });

  it("storeDoc upserts the document state through the repo", async () => {
    const state = new Uint8Array([9, 9, 9]);
    await storeDoc({ documentName: "project-p/canvas-s", state });
    expect(upsertDocDataMock).toHaveBeenCalledWith("project-p/canvas-s", state);
  });
});
