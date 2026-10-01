// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a document Space keeps its comment threads (#18, design §7).
 *
 * Threads live in the same Y.Doc as the body, under their own key, so one
 * connection carries both and a thread cannot arrive without the text it
 * points at. This fixes that key in one place for the same reason
 * `documentBodyFragment` does: the backend seeds the body and the editor binds
 * to it, and two spellings of one key would not fail loudly — the reader would
 * simply see no comments.
 *
 * TDD: red because `documentCommentThreads` does not exist yet.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import { documentBodyFragment, documentCommentThreads } from "../document-body";

describe("documentCommentThreads", () => {
  it("hands back the doc's comments map", () => {
    const doc = new Y.Doc();
    const threads = documentCommentThreads(doc);

    expect(threads).toBeInstanceOf(Y.Map);
    // The same doc answers with the same shared type, so two callers write to
    // one map rather than each creating their own.
    expect(documentCommentThreads(doc)).toBe(threads);
  });

  it("is a different key from the body, and writing one leaves the other alone", () => {
    const doc = new Y.Doc();
    const body = documentBodyFragment(doc);
    const threads = documentCommentThreads(doc);

    threads.set("t1", { resolved: false });

    expect(body.length).toBe(0);
    expect(threads.get("t1")).toEqual({ resolved: false });
  });

  it("carries threads to a second doc through one update", () => {
    // What the collaboration path does with it: a thread written on one client
    // reaches the other in the same update that carries the text, because both
    // live in one doc.
    const local = new Y.Doc();
    documentCommentThreads(local).set("t1", { resolved: false });
    documentBodyFragment(local).insert(0, [new Y.XmlElement("paragraph")]);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));

    expect(documentCommentThreads(remote).get("t1")).toEqual({
      resolved: false,
    });
    expect(documentBodyFragment(remote).length).toBe(1);
  });
});
