// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Yjs doc name builder + parser tests (multi-doc).
 *
 * Covers the v10 spec §5.3 doc-naming convention:
 *
 *   project-{pid}/meta              project meta + spaces list + tab state
 *   project-{pid}/canvas-{sid}      Canvas Space content
 *   project-{pid}/document-{sid}    Document Space content (future kind)
 *   project-{pid}/timeline-{sid}    Timeline Space content (future kind)
 *
 * The parser must round-trip every builder output and reject any other
 * shape — including the obsolete single-doc `project-{pid}` form, which
 * is no longer a valid name now that meta + per-space docs replaced it.
 */

import { describe, it, expect } from "vitest";
import {
  projectMetaDocName,
  canvasSpaceDocName,
  documentSpaceDocName,
  timelineSpaceDocName,
  spaceContentDocName,
  parseDocName,
  isProjectScopedDocName,
  type ParsedDocName,
} from "../yjs-doc-names.js";

const PID = "11111111-1111-1111-1111-111111111111";
const SID = "22222222-2222-2222-2222-222222222222";

// ── Builders ────────────────────────────────────────────────────────

describe("doc name builders", () => {
  it("projectMetaDocName builds project-{pid}/meta", () => {
    expect(projectMetaDocName(PID)).toBe(`project-${PID}/meta`);
  });

  it("canvasSpaceDocName builds project-{pid}/canvas-{sid}", () => {
    expect(canvasSpaceDocName(PID, SID)).toBe(`project-${PID}/canvas-${SID}`);
  });

  it("documentSpaceDocName builds project-{pid}/document-{sid}", () => {
    expect(documentSpaceDocName(PID, SID)).toBe(
      `project-${PID}/document-${SID}`,
    );
  });

  it("timelineSpaceDocName builds project-{pid}/timeline-{sid}", () => {
    expect(timelineSpaceDocName(PID, SID)).toBe(
      `project-${PID}/timeline-${SID}`,
    );
  });
});

// ── Parser ──────────────────────────────────────────────────────────

describe("parseDocName", () => {
  it("parses meta doc name", () => {
    const expected: ParsedDocName = { projectId: PID, kind: "meta" };
    expect(parseDocName(`project-${PID}/meta`)).toEqual(expected);
  });

  it("parses canvas space doc name", () => {
    const expected: ParsedDocName = { projectId: PID, kind: "canvas", spaceId: SID };
    expect(parseDocName(`project-${PID}/canvas-${SID}`)).toEqual(expected);
  });

  it("parses document space doc name", () => {
    const expected: ParsedDocName = { projectId: PID, kind: "document", spaceId: SID };
    expect(parseDocName(`project-${PID}/document-${SID}`)).toEqual(expected);
  });

  it("parses timeline space doc name", () => {
    const expected: ParsedDocName = { projectId: PID, kind: "timeline", spaceId: SID };
    expect(parseDocName(`project-${PID}/timeline-${SID}`)).toEqual(expected);
  });

  it("round-trips every builder", () => {
    expect(parseDocName(projectMetaDocName(PID))).toEqual({
      projectId: PID,
      kind: "meta",
    });
    expect(parseDocName(canvasSpaceDocName(PID, SID))).toEqual({
      projectId: PID,
      kind: "canvas",
      spaceId: SID,
    });
    expect(parseDocName(documentSpaceDocName(PID, SID))).toEqual({
      projectId: PID,
      kind: "document",
      spaceId: SID,
    });
    expect(parseDocName(timelineSpaceDocName(PID, SID))).toEqual({
      projectId: PID,
      kind: "timeline",
      spaceId: SID,
    });
  });

  it("rejects the obsolete single-doc form project-{pid}", () => {
    expect(parseDocName(`project-${PID}`)).toBeNull();
  });

  it("rejects legacy /canvas and /node/{id} sub-paths", () => {
    expect(parseDocName(`project-${PID}/canvas`)).toBeNull();
    expect(parseDocName(`project-${PID}/node/abc`)).toBeNull();
  });

  it("rejects unknown kind", () => {
    expect(parseDocName(`project-${PID}/whatever-${SID}`)).toBeNull();
  });

  it("rejects malformed names", () => {
    expect(parseDocName("")).toBeNull();
    expect(parseDocName("not-a-doc")).toBeNull();
    expect(parseDocName(`project-${PID}/meta/extra`)).toBeNull();
    expect(parseDocName(`project-/meta`)).toBeNull();
    expect(parseDocName(`project-${PID}/canvas-`)).toBeNull();
    // Hierarchical kinds carry an id; bare "canvas" without -{sid} is invalid:
    expect(parseDocName(`project-${PID}/canvas`)).toBeNull();
  });

  it("accepts arbitrary projectId / spaceId opaque strings (id format not validated here)", () => {
    // The shared parser intentionally does NOT enforce uuid format —
    // that is the caller's job at the persistence/auth boundary.
    expect(parseDocName("project-abc/canvas-xyz")).toEqual({
      projectId: "abc",
      kind: "canvas",
      spaceId: "xyz",
    });
    expect(parseDocName("project-abc/meta")).toEqual({
      projectId: "abc",
      kind: "meta",
    });
  });
});

// ── isProjectScopedDocName helper ───────────────────────────────────

describe("isProjectScopedDocName", () => {
  it("returns true for any valid project-scoped doc", () => {
    expect(isProjectScopedDocName(projectMetaDocName(PID))).toBe(true);
    expect(isProjectScopedDocName(canvasSpaceDocName(PID, SID))).toBe(true);
    expect(isProjectScopedDocName(documentSpaceDocName(PID, SID))).toBe(true);
    expect(isProjectScopedDocName(timelineSpaceDocName(PID, SID))).toBe(true);
  });

  it("returns false for non-project doc names", () => {
    expect(isProjectScopedDocName("not-a-project-doc")).toBe(false);
    expect(isProjectScopedDocName("")).toBe(false);
    expect(isProjectScopedDocName(`project-${PID}`)).toBe(false);
  });
});

// ── spaceContentDocName (space type → content doc name) ──────────────

describe("spaceContentDocName", () => {
  it("maps each space type to its per-kind content doc name", () => {
    expect(spaceContentDocName(PID, SID, "canvas")).toBe(
      canvasSpaceDocName(PID, SID),
    );
    expect(spaceContentDocName(PID, SID, "document")).toBe(
      documentSpaceDocName(PID, SID),
    );
    expect(spaceContentDocName(PID, SID, "timeline")).toBe(
      timelineSpaceDocName(PID, SID),
    );
  });

  it("round-trips through parseDocName with the matching kind + spaceId", () => {
    for (const kind of ["canvas", "document", "timeline"] as const) {
      expect(parseDocName(spaceContentDocName(PID, SID, kind))).toEqual({
        projectId: PID,
        kind,
        spaceId: SID,
      });
    }
  });
});
