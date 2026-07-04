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
 * `@breatic/core` is partially mocked: the real encoders stay (they need
 * no DB), only the `loadInitialSpaceType` read lazy-seed uses is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  fetchDocDataMock,
  upsertDocDataMock,
  seedInitialStateMock,
  loadInitialSpaceTypeMock,
} = vi.hoisted(() => ({
  fetchDocDataMock: vi.fn(),
  upsertDocDataMock: vi.fn(),
  seedInitialStateMock: vi.fn(),
  loadInitialSpaceTypeMock: vi.fn(),
}));

// The yjs-store repo moved to collab; persistence imports it locally.
// Mock the local repo (so its core `yjsDb` dependency never loads).
vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  fetchDocData: fetchDocDataMock,
  upsertDocData: upsertDocDataMock,
  seedInitialState: seedInitialStateMock,
}));

// Partial mock: keep core's real encoders, stub only the DB read
// lazySeedMeta uses for the chosen Space type.
vi.mock(
  "@breatic/core",
  async (importActual: () => Promise<Record<string, unknown>>) => ({
    ...(await importActual()),
    loadInitialSpaceType: loadInitialSpaceTypeMock,
    // lazy-seed writes the initial space:created activity row (PG) and
    // logs on failure - both need stubs (no DB / config under test).
    projectActivitiesRepo: { insert: vi.fn() },
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
);

import { fetchDoc, storeDoc } from "../services/persistence.js";

describe("collab persistence delegation", () => {
  beforeEach(() => {
    fetchDocDataMock.mockReset();
    upsertDocDataMock.mockReset();
    seedInitialStateMock.mockReset();
    loadInitialSpaceTypeMock.mockReset();
    loadInitialSpaceTypeMock.mockResolvedValue("canvas");
  });

  it("fetchDoc returns the repo's stored bytes for the document name", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    fetchDocDataMock.mockResolvedValue(bytes);

    const out = await fetchDoc({ documentName: "project-p/canvas-s" });

    expect(fetchDocDataMock).toHaveBeenCalledWith("project-p/canvas-s");
    expect(out).toBe(bytes);
  });

  it("fetchDoc returns null for a CANVAS doc with no live row (only meta is lazy-seeded)", async () => {
    fetchDocDataMock.mockResolvedValue(null);
    expect(await fetchDoc({ documentName: "project-p/canvas-s" })).toBeNull();
    // A canvas doc must never be lazy-seeded.
    expect(seedInitialStateMock).not.toHaveBeenCalled();
  });

  it("fetchDoc lazy-seeds a default Space for a fresh META doc with no row", async () => {
    fetchDocDataMock.mockResolvedValue(null);
    seedInitialStateMock.mockResolvedValue(true); // won the insert race

    const out = await fetchDoc({ documentName: "project-p/meta" });

    // Seeded bytes returned (non-empty initial meta state), and the seed
    // targeted the same meta doc name.
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(0);
    expect(seedInitialStateMock).toHaveBeenCalledWith(
      "project-p/meta",
      expect.any(Uint8Array),
    );
  });

  it("storeDoc upserts the document state through the repo", async () => {
    const state = new Uint8Array([9, 9, 9]);
    await storeDoc({ documentName: "project-p/canvas-s", state });
    expect(upsertDocDataMock).toHaveBeenCalledWith("project-p/canvas-s", state);
  });
});
