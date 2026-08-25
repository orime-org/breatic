// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The meta doc is read-only for clients, so a client that tries to write
 * it is either a stale build or someone probing. Nothing in the frontend
 * writes that doc any more, so this signal should never fire in normal
 * operation — which is exactly what makes it worth having.
 *
 * The predicate under test only DECIDES WHETHER TO LOG. It never rejects
 * anything: refusing the write is the framework's job, at every write
 * site, from the connection being read-only. That split is the whole
 * point. The gate this replaces had to be exhaustive about the
 * framework's internal message types, and it failed open on the ones it
 * missed — silently, for its entire life. Here, being wrong costs a log
 * line in either direction and nothing else.
 *
 * Every frame below is built the way Hocuspocus really delivers one:
 * the document name comes FIRST, because connections are multiplexed and
 * the receiver needs to know which document a frame belongs to. The old
 * gate's tests skipped that prefix, built a shape production never sends,
 * and stayed green for the whole time the gate was doing nothing.
 */

import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { describe, it, expect } from "vitest";

import { isMetaWriteAttempt } from "@collab/hooks/meta-write-attempt-log.js";

const PID = "11111111-1111-4111-8111-111111111111";
const META = `project-${PID}/meta`;
const CANVAS = `project-${PID}/canvas-22222222-2222-4222-8222-222222222222`;

const HC_SYNC = 0;
const HC_AWARENESS = 1;
const HC_SYNC_REPLY = 4;

interface FrameShape {
  /** Prepend the multiplexing document name, as production always does. */
  prefix?: boolean;
  /** Hocuspocus outer message type. */
  type: number;
  /** y-protocols sync sub-type, when the outer type carries one. */
  sub?: number;
}

/**
 * Build a Hocuspocus wire frame of the requested shape.
 * @param name - Document the frame is addressed to.
 * @param shape - Which frame shape to build.
 * @returns The framed bytes, as they arrive on the socket.
 */
function frame(name: string, shape: FrameShape): Uint8Array {
  const enc = encoding.createEncoder();
  if (shape.prefix !== false) encoding.writeVarString(enc, name);
  encoding.writeVarUint(enc, shape.type);
  if (shape.sub !== undefined) {
    encoding.writeVarUint(enc, shape.sub);
    encoding.writeVarUint8Array(enc, new Uint8Array([1, 2, 3]));
  }
  return encoding.toUint8Array(enc);
}

const CLIENT = { user: { id: "a-real-user-id" } };

describe("isMetaWriteAttempt", () => {
  it("reports a client update aimed at the meta doc", () => {
    const f = frame(META, {
      type: HC_SYNC,
      sub: syncProtocol.messageYjsUpdate,
    });
    expect(isMetaWriteAttempt(META, f, CLIENT)).toBe(true);
  });

  it("reports the same update sent under the SyncReply type", () => {
    // Sync and SyncReply reach the same apply branch in the framework, so
    // a client can send a write under either. The gate this replaces
    // recognised only the first and let the second through untouched.
    const f = frame(META, {
      type: HC_SYNC_REPLY,
      sub: syncProtocol.messageYjsUpdate,
    });
    expect(isMetaWriteAttempt(META, f, CLIENT)).toBe(true);
  });

  it("stays quiet for collab's own privileged writes", () => {
    // The RPC handlers write through a direct connection, which does not
    // go through this hook at all — but the context marker is checked
    // anyway so the predicate is right on its own terms.
    const f = frame(META, {
      type: HC_SYNC,
      sub: syncProtocol.messageYjsUpdate,
    });
    expect(isMetaWriteAttempt(META, f, { user: { id: "system" } })).toBe(false);
  });

  it("stays quiet for content docs", () => {
    // A canvas or a document body is the user's own work. Writing it is
    // the entire point, and role already decides who may.
    const f = frame(CANVAS, {
      type: HC_SYNC,
      sub: syncProtocol.messageYjsUpdate,
    });
    expect(isMetaWriteAttempt(CANVAS, f, CLIENT)).toBe(false);
  });

  it("stays quiet for handshake and awareness traffic", () => {
    // Every client sends these on every connect. Logging them would bury
    // the one line that matters under noise from normal operation.
    const step1 = frame(META, {
      type: HC_SYNC,
      sub: syncProtocol.messageYjsSyncStep1,
    });
    const step2 = frame(META, {
      type: HC_SYNC,
      sub: syncProtocol.messageYjsSyncStep2,
    });
    const awareness = frame(META, { type: HC_AWARENESS });
    expect(isMetaWriteAttempt(META, step1, CLIENT)).toBe(false);
    expect(isMetaWriteAttempt(META, step2, CLIENT)).toBe(false);
    expect(isMetaWriteAttempt(META, awareness, CLIENT)).toBe(false);
  });

  it("does not throw on a frame it cannot parse", () => {
    // Deciding whether to log must never be able to break a connection.
    for (const bad of [
      new Uint8Array([]),
      new Uint8Array([255, 255, 255]),
      frame(META, { type: HC_SYNC }),
    ]) {
      expect(() => isMetaWriteAttempt(META, bad, CLIENT)).not.toThrow();
      expect(isMetaWriteAttempt(META, bad, CLIENT)).toBe(false);
    }
  });

  it("does not treat a frame without the document-name prefix as a write", () => {
    // The regression pin. A frame with no prefix is not a shape production
    // sends; if this ever starts returning true, someone has dropped the
    // step that reads the name off the front, and the predicate is reading
    // the name's byte length where it thinks the message type is. That is
    // precisely how the previous gate came to never run.
    const f = frame(META, {
      prefix: false,
      type: HC_SYNC,
      sub: syncProtocol.messageYjsUpdate,
    });
    expect(isMetaWriteAttempt(META, f, CLIENT)).toBe(false);
  });
});
