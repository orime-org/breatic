/**
 * Unit tests for the meta-doc write-authorization hook.
 *
 * Pins these properties (per ADR 2026-05-23-yjs-collab-only-write-authz):
 *
 *   - Direct client writes to `meta.spaces` are refused (must use RPC)
 *   - Direct client writes to `meta.projectMessages` are refused
 *   - Client may write its own `meta.perUser[userId]` entry
 *   - Client may not create / modify / delete another user's
 *     `meta.perUser[otherUserId]` entry
 *   - `context.user.id === 'system'` bypasses the gate (collab self-write)
 *   - Non-meta docs (canvas / document / timeline) are not gated here
 */
import * as encoding from "lib0/encoding";
import { describe, it, expect } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { checkWriteAuthz, WriteAuthzError } from "../before-handle-message.js";

const PID = "11111111-1111-4111-8111-111111111111";
const META = `project-${PID}/meta`;

/**
 * Hocuspocus protocol message types (mirror `@hocuspocus/server`
 * `MessageType` enum). Used by tests to forge envelope-skip paths.
 */
const HC_MESSAGE_TYPE_SYNC = 0;
const HC_MESSAGE_TYPE_AWARENESS = 1;
const HC_MESSAGE_TYPE_STATELESS = 5;

/** Build a seed meta doc + return the doc. */
function makeSeededMetaDoc(seed: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => seed(doc));
  return doc;
}

/**
 * Encode a mutation as a real **Hocuspocus WebSocket frame** wrapping
 * a Yjs sync-update message: `[Sync=0][messageYjsUpdate=2][updateBytes]`.
 *
 * Production `beforeHandleMessage` receives bytes in this shape, NOT
 * a bare Yjs update. Earlier versions of these tests fed bare updates
 * and silently passed while the real gate crashed on every client
 * connection (lib0 `Invalid typed array length`). Wrapping at the
 * helper level keeps each test focused on the policy it pins, while
 * still exercising the envelope-unwrap branch end-to-end.
 */
function encodeMutation(start: Y.Doc, mutate: (doc: Y.Doc) => void): Uint8Array {
  const before = Y.encodeStateVector(start);
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, Y.encodeStateAsUpdate(start));
  tmp.transact(() => mutate(tmp));
  const updateBytes = Y.encodeStateAsUpdate(tmp, before);

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, HC_MESSAGE_TYPE_SYNC);
  encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
  encoding.writeVarUint8Array(encoder, updateBytes);
  return encoding.toUint8Array(encoder);
}

/**
 * Build a Hocuspocus frame with the given top-level messageType + a
 * single varUint payload (`payloadByte`). Used to forge non-sync
 * messages (awareness / stateless / etc.) that must skip the gate.
 */
function encodeNonSyncFrame(messageType: number, payloadByte = 0): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  encoding.writeVarUint(encoder, payloadByte);
  return encoding.toUint8Array(encoder);
}

/** Build a sync frame with a non-update sub-type (step 1 / step 2). */
function encodeSyncFrameWithSubType(syncSubType: number): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, HC_MESSAGE_TYPE_SYNC);
  encoding.writeVarUint(encoder, syncSubType);
  // sync-step-1 payload is a state vector; sync-step-2 carries an
  // update. We don't need a valid payload to test that the gate
  // skips early — gate returns before reading further.
  encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
  return encoding.toUint8Array(encoder);
}

describe("checkWriteAuthz — meta.spaces", () => {
  it("rejects a client adding a new entry to meta.spaces", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    const update = encodeMutation(current, (doc) => {
      const entry = new Y.Map();
      entry.set("id", "sneaky");
      doc.getMap("spaces").set("sneaky", entry);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(WriteAuthzError);
  });

  it("rejects a client removing an entry from meta.spaces", () => {
    const current = makeSeededMetaDoc((doc) => {
      const entry = new Y.Map();
      entry.set("id", "sp-1");
      doc.getMap("spaces").set("sp-1", entry);
    });
    const update = encodeMutation(current, (doc) => {
      doc.getMap("spaces").delete("sp-1");
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(/meta\.spaces/);
  });
});

describe("checkWriteAuthz — meta.projectMessages", () => {
  it("rejects a client pushing into meta.projectMessages", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getArray("projectMessages");
    });
    const update = encodeMutation(current, (doc) => {
      const entry = new Y.Map();
      entry.set("id", "m1");
      entry.set("kind", "missing-node");
      doc.getArray("projectMessages").push([entry]);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(/projectMessages/);
  });
});

describe("checkWriteAuthz — meta.users", () => {
  it("rejects a client adding an entry to meta.users", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("users");
    });
    const update = encodeMutation(current, (doc) => {
      const entry = new Y.Map();
      entry.set("id", "user-2");
      entry.set("name", "Spoofed");
      doc.getMap("users").set("user-2", entry);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(/meta\.users/);
  });

  it("rejects a client mutating their own entry directly (must go via RPC)", () => {
    // Even self-writes are refused — the only legitimate writer is
    // the users:upsert-self RPC handler running under the 'system'
    // privileged context.
    const current = makeSeededMetaDoc((doc) => {
      const entry = new Y.Map();
      entry.set("id", "user-1");
      entry.set("name", "Original");
      doc.getMap("users").set("user-1", entry);
    });
    const update = encodeMutation(current, (doc) => {
      const entry = doc.getMap("users").get("user-1") as Y.Map<unknown>;
      entry.set("name", "TamperedSelf");
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(/meta\.users/);
  });
});

describe("checkWriteAuthz — meta.perUser", () => {
  it("allows the connected user to add their own entry", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("perUser");
    });
    const update = encodeMutation(current, (doc) => {
      const own = new Y.Map();
      own.set("activeSpaceId", "sp-1");
      doc.getMap("perUser").set("user-1", own);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("allows the connected user to mutate their own pre-existing entry", () => {
    const current = makeSeededMetaDoc((doc) => {
      const own = new Y.Map();
      own.set("activeSpaceId", "sp-1");
      doc.getMap("perUser").set("user-1", own);
    });
    const update = encodeMutation(current, (doc) => {
      const own = doc.getMap("perUser").get("user-1") as Y.Map<unknown>;
      own.set("activeSpaceId", "sp-2");
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("rejects creating an entry for another user", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("perUser");
    });
    const update = encodeMutation(current, (doc) => {
      const other = new Y.Map();
      other.set("activeSpaceId", "sp-evil");
      doc.getMap("perUser").set("user-2", other);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(/another user/);
  });

  it("rejects modifying a pre-existing entry belonging to another user", () => {
    const current = makeSeededMetaDoc((doc) => {
      const other = new Y.Map();
      other.set("activeSpaceId", "sp-3");
      doc.getMap("perUser").set("user-2", other);
    });
    const update = encodeMutation(current, (doc) => {
      const other = doc.getMap("perUser").get("user-2") as Y.Map<unknown>;
      other.set("activeSpaceId", "sp-evil");
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(/another user/);
  });

  it("rejects deleting a pre-existing entry belonging to another user", () => {
    const current = makeSeededMetaDoc((doc) => {
      const other = new Y.Map();
      other.set("activeSpaceId", "sp-3");
      doc.getMap("perUser").set("user-2", other);
    });
    const update = encodeMutation(current, (doc) => {
      doc.getMap("perUser").delete("user-2");
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).toThrow(/another user/);
  });
});

describe("checkWriteAuthz — system bypass + non-meta docs", () => {
  it("allows the system user to write meta.spaces (used by space-rpc)", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    const update = encodeMutation(current, (doc) => {
      const entry = new Y.Map();
      entry.set("id", "sp-new");
      doc.getMap("spaces").set("sp-new", entry);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "system" } },
      }),
    ).not.toThrow();
  });

  it("skips the gate entirely for canvas / document / timeline docs", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    const update = encodeMutation(current, (doc) => {
      const entry = new Y.Map();
      doc.getMap("spaces").set("any", entry);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: `project-${PID}/canvas-some-space-id`,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("rejects writes from an anonymous context (no userId) on the meta doc", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("perUser");
    });
    const update = encodeMutation(current, (doc) => {
      const own = new Y.Map();
      own.set("activeSpaceId", "sp-1");
      doc.getMap("perUser").set("user-1", own);
    });
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: {},
      }),
    ).toThrow(/Anonymous/);
  });
});

/**
 * Regression pins for the Hocuspocus envelope handling bug. The PR-a
 * version of this hook treated the `update` arg as a bare Yjs update,
 * so EVERY meta connection died with lib0 `Invalid typed array length`
 * the first time the client sent any frame (sync-step-1, awareness,
 * etc.). These cases lock in that:
 *
 *   - non-sync messageTypes (awareness, stateless) skip the gate
 *   - sync sub-types other than `messageYjsUpdate` skip the gate
 *   - malformed envelope bytes skip the gate (MessageReceiver will
 *     close the connection on its own; we don't double-throw)
 */
describe("checkWriteAuthz — Hocuspocus envelope handling", () => {
  it("skips the gate for awareness messages (messageType=1)", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    const update = encodeNonSyncFrame(HC_MESSAGE_TYPE_AWARENESS);
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("skips the gate for stateless RPC messages (messageType=5)", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    const update = encodeNonSyncFrame(HC_MESSAGE_TYPE_STATELESS);
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("skips the gate for sync-step-1 sub-type (state vector handshake)", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    const update = encodeSyncFrameWithSubType(
      syncProtocol.messageYjsSyncStep1,
    );
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("skips the gate for sync-step-2 sub-type (reconnect bootstrap)", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    const update = encodeSyncFrameWithSubType(
      syncProtocol.messageYjsSyncStep2,
    );
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("skips the gate for malformed envelope bytes (Hocuspocus closes elsewhere)", () => {
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("spaces");
    });
    // Truncated / random bytes — no valid envelope to decode.
    const update = new Uint8Array([0xff, 0xff, 0xff]);
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });

  it("does NOT throw lib0 binary errors on a real-shaped sync-update frame (PR-a regression)", () => {
    // This is the exact failure mode PR-a shipped with: any sync-
    // update frame would crash Y.applyUpdate(clone, rawFrame) with
    // 'Invalid typed array length' inside lib0 before the gate logic
    // even ran, and Hocuspocus would close the connection.
    const current = makeSeededMetaDoc((doc) => {
      doc.getMap("perUser");
    });
    const update = encodeMutation(current, (doc) => {
      const own = new Y.Map();
      own.set("activeSpaceId", "sp-1");
      doc.getMap("perUser").set("user-1", own);
    });
    // Should be allowed (perUser self-write) AND not throw any
    // RangeError / "Unexpected end of array" coming from lib0.
    expect(() =>
      checkWriteAuthz({
        documentName: META,
        document: current,
        update,
        context: { user: { id: "user-1" } },
      }),
    ).not.toThrow();
  });
});
