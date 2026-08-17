// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  shouldRegisterConnection,
  shouldTrackConnection,
} from "@collab/services/connection-tracking.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const CANVAS = `project-${PID}/canvas-${SID}`;

describe("shouldTrackConnection (#1421 per-document cap tracking policy)", () => {
  it("tracks Space content docs (canvas / document / timeline)", () => {
    expect(shouldTrackConnection(`project-${PID}/canvas-${SID}`)).toBe(true);
    expect(shouldTrackConnection(`project-${PID}/document-${SID}`)).toBe(true);
    expect(shouldTrackConnection(`project-${PID}/timeline-${SID}`)).toBe(true);
  });

  it("does NOT track the meta doc — it is exempt from the cap", () => {
    expect(shouldTrackConnection(`project-${PID}/meta`)).toBe(false);
  });

  it("does NOT track non-project doc names (e.g. the healthz sentinel)", () => {
    expect(shouldTrackConnection("__healthz_probe__")).toBe(false);
    expect(shouldTrackConnection("random-doc-name")).toBe(false);
    // Obsolete pre-v10 single-doc form parses to null → not tracked.
    expect(shouldTrackConnection(`project-${PID}`)).toBe(false);
  });
});

describe("shouldRegisterConnection (#88 — only writable connections take a seat)", () => {
  it("registers a writable connection to a Space content doc", () => {
    expect(shouldRegisterConnection(CANVAS, false)).toBe(true);
  });

  it("does NOT register a read-only connection", () => {
    // What the ceiling counts is how many may WRITE. A read-only connection
    // holding a seat is the bug this fixes: it was invisible while the
    // ceiling was 100, but at 2 an owner plus one viewer filled a document
    // and the next editor was pushed to read-only for no reason.
    //
    // One flag covers all three ways a connection ends up read-only — the
    // viewer role, the document being full, and a tier that could not be
    // resolved — because the auth hook has already folded them into
    // `connectionConfig.readOnly` by the time this is asked.
    expect(shouldRegisterConnection(CANVAS, true)).toBe(false);
  });

  it("does NOT register the meta doc, writable or not", () => {
    // The meta doc is exempt from the ceiling, so it never takes a seat —
    // and every client's connection to it is read-only anyway.
    expect(shouldRegisterConnection(`project-${PID}/meta`, false)).toBe(false);
    expect(shouldRegisterConnection(`project-${PID}/meta`, true)).toBe(false);
  });

  it("does NOT register a non-project doc name, writable or not", () => {
    expect(shouldRegisterConnection("__healthz_probe__", false)).toBe(false);
  });

  it("is a strict subset of what shouldTrackConnection covers", () => {
    // The two are deliberately NOT symmetric, and this states the direction
    // of the asymmetry: anything registered is something the unregister side
    // will also visit, never the other way round.
    //
    // Why they cannot be one predicate: the unregister side is the
    // `onDisconnect` hook, and its payload has no `connectionConfig` at all
    // (checked against @hocuspocus/server 4.6.0 — `onDisconnectPayload`
    // carries clientsCount, context, document, documentName, instance,
    // requestHeaders, requestParameters and socketId, and nothing else). So
    // it cannot ask whether the connection was writable. It does not need
    // to: removing a member that was never added is a no-op in Redis, so
    // unregistering unconditionally is correct and idempotent.
    for (const readOnly of [true, false]) {
      for (const name of [
        CANVAS,
        `project-${PID}/meta`,
        "__healthz_probe__",
      ]) {
        if (shouldRegisterConnection(name, readOnly)) {
          expect(shouldTrackConnection(name)).toBe(true);
        }
      }
    }
  });
});
