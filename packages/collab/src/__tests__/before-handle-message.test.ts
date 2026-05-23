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
import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import { checkWriteAuthz, WriteAuthzError } from "../before-handle-message.js";

const PID = "11111111-1111-4111-8111-111111111111";
const META = `project-${PID}/meta`;

/** Build a seed meta doc + return both the doc and an encoded update
 * representing the seed (so tests can apply it to a fresh "current"
 * doc and then encode a follow-up mutation as the `update` argument). */
function makeSeededMetaDoc(seed: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => seed(doc));
  return doc;
}

/** Encode a mutation as a binary update — what Hocuspocus actually
 * passes to `beforeHandleMessage` from the wire. */
function encodeMutation(start: Y.Doc, mutate: (doc: Y.Doc) => void): Uint8Array {
  const before = Y.encodeStateVector(start);
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, Y.encodeStateAsUpdate(start));
  tmp.transact(() => mutate(tmp));
  return Y.encodeStateAsUpdate(tmp, before);
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
