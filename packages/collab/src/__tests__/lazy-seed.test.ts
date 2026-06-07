// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * lazySeedMeta unit tests (B.2 — meta + first Space content doc are one
 * thing, seeded together; the content doc name follows the Space type).
 *
 * Mock surface:
 *   - @collab/services/yjs-documents.repo — `seedInitialState` /
 *     `fetchDocData` are vi.fn() stubs so we can assert WHICH docs are
 *     seeded and in WHAT order without a real PG.
 *   - @breatic/core — partial mock: real encoders (encodeInitialMetaState
 *     / encodeInitialSpaceContentState / defaultSpaceName) stay, only the
 *     DB read `loadInitialSpaceType` is stubbed to drive the chosen type.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

const { loadInitialSpaceTypeMock, seedInitialStateMock, fetchDocDataMock } =
  vi.hoisted(() => ({
    loadInitialSpaceTypeMock: vi.fn(),
    seedInitialStateMock: vi.fn(),
    fetchDocDataMock: vi.fn(),
  }));

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  seedInitialState: seedInitialStateMock,
  fetchDocData: fetchDocDataMock,
}));

vi.mock(
  "@breatic/core",
  async (importActual: () => Promise<Record<string, unknown>>) => ({
    ...(await importActual()),
    loadInitialSpaceType: loadInitialSpaceTypeMock,
  }),
);

import { lazySeedMeta } from "../services/lazy-seed.js";
import {
  canvasSpaceDocName,
  deriveId,
  projectMetaDocName,
  spaceContentDocName,
} from "@breatic/shared";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  loadInitialSpaceTypeMock.mockResolvedValue("canvas");
  seedInitialStateMock.mockResolvedValue(true);
});

describe("lazySeedMeta", () => {
  it("returns null for a non-meta doc (only meta docs lazy-seed here)", async () => {
    expect(await lazySeedMeta(canvasSpaceDocName(PID, SID))).toBeNull();
    expect(seedInitialStateMock).not.toHaveBeenCalled();
  });

  it("seeds the first Space's content doc AND meta, content doc FIRST", async () => {
    const metaName = projectMetaDocName(PID);
    const bytes = await lazySeedMeta(metaName);
    expect(bytes).toBeInstanceOf(Uint8Array);

    expect(loadInitialSpaceTypeMock).toHaveBeenCalledWith(PID);

    const spaceId = deriveId(PID);
    const contentName = spaceContentDocName(PID, spaceId, "canvas");
    const seededNames = seedInitialStateMock.mock.calls.map((c) => c[0] as string);
    expect(seededNames).toContain(contentName);
    expect(seededNames).toContain(metaName);
    // A Space must never be visible in meta before its content doc exists
    // (the same invariant duplicateByProjectPrefix upholds).
    expect(seededNames.indexOf(contentName)).toBeLessThan(
      seededNames.indexOf(metaName),
    );
  });

  it("uses the chosen type for BOTH the meta entry and the content doc name", async () => {
    loadInitialSpaceTypeMock.mockResolvedValue("document");
    const metaName = projectMetaDocName(PID);
    const bytes = (await lazySeedMeta(metaName)) as Uint8Array;

    // meta entry carries the chosen type + its default name
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    const spaceId = deriveId(PID);
    const entry = doc.getMap("spaces").get(spaceId) as Y.Map<unknown>;
    expect(entry.get("type")).toBe("document");
    expect(entry.get("name")).toBe("Document");

    // content doc seeded under the document-{spaceId} name, not canvas-
    const seededNames = seedInitialStateMock.mock.calls.map((c) => c[0] as string);
    expect(seededNames).toContain(spaceContentDocName(PID, spaceId, "document"));
  });
});
