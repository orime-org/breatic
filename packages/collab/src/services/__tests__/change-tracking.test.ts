// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Noticing that a document changed (#40).
 *
 * Gate 2 round 2 findings 6 and 10. This used to hang off the server's
 * config-level `onChange`, which `configure()` pushes to the END of the
 * extension array — so it ran behind every extension, including the Redis one
 * that publishes each update to the other instances. `hooks()` chains
 * extensions with `.then`, so a Redis publish that rejects skips every hook
 * behind it. The counter never moved, the document read as clean, the timed
 * loop skipped it and the unload gate let it go: content typed by a real user,
 * gone, with nothing logged.
 *
 * The fix is not to move up the queue but to leave it. The Yjs document's own
 * `update` event is where the library's `onChange` comes from in the first
 * place (`hocuspocus-server.esm.js:512` binds it, `:679` forwards it, `:1404`
 * fires the hooks), so listening to the document directly gets the same events
 * one step earlier, synchronously, and with nothing in between that could fail.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";

vi.mock("@breatic/core", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  captureUnhandledRejections,
  createLiveServer,
  connectLiveClient,
  type RejectionTrap,
} from "../../__tests__/helpers/live-hocuspocus.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import {
  beginStore,
  commitStore,
  forgetDocument,
  hasUnsavedContent,
} from "@collab/services/store-tracker.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";

let rejections: RejectionTrap;

beforeEach(() => {
  forgetDocument(DOC);
  // The library fires the onChange chain without awaiting it
  // (`Hocuspocus.ts:573`), so an extension that rejects there rejects with
  // nobody listening. That is the production behaviour under test, not a
  // test artefact — and left uncaught it takes the whole file down.
  rejections = captureUnhandledRejections();
});

afterEach(() => rejections.restore());

/**
 * Stand up a live server that tracks changes, optionally behind a saboteur.
 * @param sabotage - Which hook a higher-priority extension should reject in.
 * @returns The instance.
 */
function serverWith(sabotage?: "onChange" | "afterLoadDocument") {
  const extensions: unknown[] = [createChangeTrackingExtension()];
  if (sabotage) {
    extensions.push({
      // Same priority the Redis extension carries. It is the highest of any
      // extension we ship, so a tracker that survives this survives anything
      // short of a deliberate change to the ordering.
      priority: 1000,
      [sabotage]: async (): Promise<void> => {
        throw new Error("upstream extension rejected");
      },
    });
  }
  return createLiveServer({ extensions });
}

describe("noticing a change", () => {
  it("counts an ordinary edit", async () => {
    const hocuspocus = serverWith();
    const client = await connectLiveClient(hocuspocus, DOC);
    const document = hocuspocus.documents.get(DOC)!;
    forgetDocument(DOC);

    document.getText("body").insert(0, "typed by a person");
    await new Promise((r) => setTimeout(r, 20));

    expect(hasUnsavedContent(DOC)).toBe(true);
    client.close();
  });

  it("counts an update relayed from another instance", async () => {
    // What makes a surviving instance store on behalf of one that died. This
    // is exactly how @hocuspocus/extension-redis applies a peer's update.
    const hocuspocus = serverWith();
    const client = await connectLiveClient(hocuspocus, DOC);
    const document = hocuspocus.documents.get(DOC)!;
    forgetDocument(DOC);

    document.transact(
      () => {
        document.getText("body").insert(0, "typed on the other instance");
      },
      { source: "redis" },
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(hasUnsavedContent(DOC)).toBe(true);
    client.close();
  });

  it("still counts when a higher-priority extension aborts the onChange chain", async () => {
    const hocuspocus = serverWith("onChange");
    const client = await connectLiveClient(hocuspocus, DOC);
    const document = hocuspocus.documents.get(DOC)!;
    forgetDocument(DOC);

    document.getText("body").insert(0, "typed while Redis was down");
    await new Promise((r) => setTimeout(r, 20));

    expect(hasUnsavedContent(DOC)).toBe(true);
    // And the rejection really did escape unhandled, which is what makes the
    // truncation this test is about happen at all.
    expect(rejections.escaped).toContain("upstream extension rejected");
    client.close();
  });

  it("does not count the load itself — a freshly loaded document is clean", async () => {
    // Attaching during `onLoadDocument` would see persistence apply the
    // stored bytes and call that a change, so the very first timed round
    // would write back exactly what it had just read.
    const hocuspocus = createLiveServer({
      extensions: [
        createChangeTrackingExtension(),
        {
          onLoadDocument: async ({ document }: { document: Y.Doc }): Promise<void> => {
            const seed = new Y.Doc();
            seed.getText("body").insert(0, "what the database had");
            Y.applyUpdate(document, Y.encodeStateAsUpdate(seed));
          },
        },
      ],
    });
    const client = await connectLiveClient(hocuspocus, DOC);
    await new Promise((r) => setTimeout(r, 20));

    expect(hasUnsavedContent(DOC)).toBe(false);
    client.close();
  });
});

describe("letting a document go", () => {
  it("forgets its bookkeeping once it has left memory", async () => {
    const hocuspocus = serverWith();
    const client = await connectLiveClient(hocuspocus, DOC);
    const document = hocuspocus.documents.get(DOC)!;
    document.getText("body").insert(0, "x");
    await new Promise((r) => setTimeout(r, 20));
    expect(hasUnsavedContent(DOC)).toBe(true);

    const tracker = createChangeTrackingExtension();
    await tracker.afterUnloadDocument({ documentName: DOC });

    expect(hasUnsavedContent(DOC)).toBe(false);
    client.close();
  });
});

describe("a load that fails after we have already attached", () => {
  // Gate 2 round 3 findings 1 and 4. The library wraps only `onLoadDocument`
  // in a try/catch (hocuspocus-server.esm.js:1467-1475); `afterLoadDocument`
  // at :1482 is outside it. So a later extension throwing there — the Redis
  // one rethrows when its initial-sync publish rejects — makes `loadDocument`
  // reject, the document never enters `instance.documents`, `unloadDocument`
  // bails at :1568, and `afterUnloadDocument` never fires. That hook is the
  // only thing that clears our bookkeeping.
  //
  // The early return that made attaching idempotent then became the bug: the
  // stale entry says "already watching" for a document that no longer exists,
  // so the next load of that name attaches nothing and every edit in that
  // session is invisible.

  it("still watches the next document loaded under that name", async () => {
    const tracker = createChangeTrackingExtension();
    const abandoned = new Y.Doc();
    await tracker.afterLoadDocument({ documentName: DOC, document: abandoned });
    // The load failed here. No afterUnloadDocument, so nothing was cleared.

    const reloaded = new Y.Doc();
    await tracker.afterLoadDocument({ documentName: DOC, document: reloaded });
    forgetDocument(DOC);
    reloaded.getText("body").insert(0, "typed after the failed load");

    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("stops watching the document that was abandoned", async () => {
    // Otherwise its updates keep counting against a name that now belongs to
    // a different document, and the tracker holds it alive.
    const tracker = createChangeTrackingExtension();
    const abandoned = new Y.Doc();
    await tracker.afterLoadDocument({ documentName: DOC, document: abandoned });

    const reloaded = new Y.Doc();
    await tracker.afterLoadDocument({ documentName: DOC, document: reloaded });
    forgetDocument(DOC);
    abandoned.getText("body").insert(0, "a ghost typing into a dead document");

    expect(hasUnsavedContent(DOC)).toBe(false);
  });

  it("attaching twice for the same document does not count each update twice", async () => {
    const tracker = createChangeTrackingExtension();
    const document = new Y.Doc();
    await tracker.afterLoadDocument({ documentName: DOC, document });
    await tracker.afterLoadDocument({ documentName: DOC, document });
    forgetDocument(DOC);

    document.getText("body").insert(0, "x");
    const ticket = beginStore(DOC);
    commitStore(DOC, ticket);

    expect(hasUnsavedContent(DOC)).toBe(false);
  });
});
