// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Space-existence check against a REAL Hocuspocus server (#26).
 *
 * The check answers from the meta doc this process holds, and makes sure it
 * holds one before answering. Both halves need the running framework to be
 * observable: whether the doc is really in `instance.documents` at handshake
 * time, and whether loading it when it is not lands the same content a client
 * would have seen. A hand-written stand-in for the document table can show
 * neither — it and the interface it satisfies would be written in the same
 * commit, so between them they could only prove the hook does what the hook
 * was written to do.
 *
 * So these run the framework, with the real persistence extension wired (its
 * `fetch` injected, so no database is involved). A client opens documents the
 * way a browser does, the meta doc is changed IN MEMORY ONLY — exactly what
 * `space:create` and `space:delete` do — and the stored side is staged to
 * disagree. Whichever side answered is then visible in the outcome.
 *
 * Staging the stored side to disagree is not an artificial setup. It IS the
 * window the bug lived in: the create path triggers no store of its own, so
 * the `yjs_documents` row trails the in-memory doc by up to one
 * `store_interval_ms` tick (10s in `config/collab.yaml`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";

const { getSessionMock, loadProjectRoleMock, fetchDocDataMock } = vi.hoisted(
  () => ({
    getSessionMock: vi.fn(),
    loadProjectRoleMock: vi.fn(),
    fetchDocDataMock: vi.fn(),
  }),
);

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  fetchDocData: fetchDocDataMock,
  softDeleteByName: vi.fn(),
  restoreByName: vi.fn(),
  seedInitialState: vi.fn(),
  countLiveSpaceDocs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    getSession: getSessionMock,
    sessionCookieName: () => "sid",
    projectAuthService: { loadProjectRole: loadProjectRoleMock },
  };
});

import { createAuthHook } from "@collab/hooks/auth.js";
import { createPersistenceExtension } from "@collab/services/persistence.js";
import { projectMetaDocName, spaceContentDocName } from "@breatic/shared";
import {
  connectLiveClient,
  createLiveServer,
  type LiveClient,
} from "./helpers/live-hocuspocus.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const META_DOC = projectMetaDocName(PID);
const DOCUMENT_DOC = spaceContentDocName(PID, SID, "document");
const COOKIE = "sid=session-token";

let server: Hocuspocus;
let clients: LiveClient[];
/** What the stored side hands back when a document is loaded. */
let stored: Map<string, Uint8Array>;

/**
 * Encode a meta doc listing exactly the given Spaces — the state the stored
 * side would hand back on load.
 * @param ids - Space ids the stored row claims exist.
 * @returns Encoded Yjs state.
 */
function storedMetaWith(ids: string[]): Uint8Array {
  const doc = new Y.Doc();
  const spaces = doc.getMap("spaces");
  for (const id of ids) {
    const entry = new Y.Map<unknown>();
    spaces.set(id, entry);
    entry.set("id", id);
  }
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Change the meta doc this process holds, without touching the stored side —
 * the same reach `space-rpc.ts` uses for `space:create` and `space:delete`.
 * @param mutate - Applied to the live document inside a transaction.
 */
async function mutateLiveMetaDoc(mutate: (live: Y.Doc) => void): Promise<void> {
  const direct = await server.openDirectConnection(META_DOC, {
    context: { user: { id: "system" } },
  });
  await direct.transact(mutate);
  await direct.disconnect();
}

/**
 * Open a document the way a browser does and remember the client so
 * `afterEach` can clear its keep-alive timer.
 * @param docName - Document to open.
 * @returns The connected — or refused — client.
 */
async function connect(docName: string): Promise<LiveClient> {
  const client = await connectLiveClient(server, docName, { cookie: COOKIE });
  clients.push(client);
  return client;
}

beforeEach(() => {
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue("user-1");
  loadProjectRoleMock.mockReset();
  loadProjectRoleMock.mockResolvedValue("editor");
  fetchDocDataMock.mockReset();
  clients = [];
  stored = new Map();
  server = createLiveServer({
    // The real load path, with only its storage read injected. Without an
    // extension the framework loads an empty document, which would make every
    // case below pass for the wrong reason.
    extensions: [
      createPersistenceExtension({
        fetch: async ({ documentName }: { documentName: string }) =>
          stored.get(documentName) ?? null,
      }),
    ],
    onAuthenticate: createAuthHook({
      redis: {} as never,
      // The ceiling is not this suite's subject. It used to say `0`, which
      // meant "unlimited" back when this was a constant; zero is now a real
      // zero (#88), so say the intent with a number nobody reaches.
      resolveConnectionLimit: async (): Promise<number> => 1000,
      countConnections: async (): Promise<number> => 0,
    }),
  });
});

afterEach(() => {
  for (const client of clients) client.close();
});

describe("Space existence over a live server", () => {
  it("admits a Space that only the in-memory meta doc knows about", async () => {
    // The stored side is one store tick behind and lists no Spaces at all.
    stored.set(META_DOC, storedMetaWith([]));
    const metaClient = await connect(META_DOC);
    expect(metaClient.authenticated).toBe(true);

    // `space:create` in miniature: the id lands in memory and is broadcast,
    // and nothing is written to storage.
    await mutateLiveMetaDoc((live) => {
      const entry = new Y.Map<unknown>();
      live.getMap("spaces").set(SID, entry);
      entry.set("id", SID);
    });

    const client = await connect(DOCUMENT_DOC);

    expect(client.authenticated).toBe(true);
  });

  it("refuses a Space the in-memory meta doc has dropped, while storage still lists it", async () => {
    // The mirror image, and the half a browser cannot be made to reproduce:
    // after `space:delete` the id is gone from memory at once while the stored
    // row keeps listing it until the next store tick.
    stored.set(META_DOC, storedMetaWith([SID]));
    const metaClient = await connect(META_DOC);
    expect(metaClient.authenticated).toBe(true);

    await mutateLiveMetaDoc((live) => {
      live.getMap("spaces").delete(SID);
    });

    const client = await connect(DOCUMENT_DOC);

    expect(client.authenticated).toBe(false);
  });

  it("loads the meta doc itself when this process holds none", async () => {
    // Nobody has opened the meta doc, so the check has to put it in memory
    // before it can answer. The old behaviour — decoding a private copy from
    // storage — left `instance.documents` untouched.
    stored.set(META_DOC, storedMetaWith([SID]));

    const client = await connect(DOCUMENT_DOC);

    expect(client.authenticated).toBe(true);
    expect(fetchDocDataMock).not.toHaveBeenCalled();
  });

  it("admits a reconnecting client whose content docs handshake alongside the meta doc", async () => {
    // The shape the logs show (2026-08-10 11:13:21): an instance comes up, a
    // browser that has already synced reconnects every open document at once,
    // and the content-doc handshakes arrive with — not after — the meta doc's.
    // Before #26 that is where nearly every refusal came from: the content
    // handshake ran while this process still held no meta doc, and the answer
    // came from a private copy decoded out of storage.
    //
    // What this pins is the CONCURRENCY: nothing here is holding the meta doc,
    // both handshakes go out together, and the content doc is still admitted.
    //
    // The other half — that the answer comes from the list rather than from
    // storage when the two disagree — cannot be staged ON THIS PATH. Here
    // nothing holds the meta doc, so the list is produced by the load itself,
    // out of the very storage it would have to disagree with. Making them
    // disagree means writing to the in-memory doc, and writing to it means
    // loading it, which removes the precondition this case is about. (The two
    // cases above are not counter-examples: they do hold the meta doc, which
    // is exactly why they can stage the disagreement.) That half is pinned
    // across two real instances in
    // `packages/server/src/__tests__/integration/collab-space-existence-multi-instance.integration.test.ts`.
    stored.set(META_DOC, storedMetaWith([SID]));

    const [metaClient, contentClient] = await Promise.all([
      connect(META_DOC),
      connect(DOCUMENT_DOC),
    ]);

    expect(metaClient.authenticated).toBe(true);
    expect(contentClient.authenticated).toBe(true);
  });

  it("refuses when the meta doc cannot be read at all", async () => {
    // Nothing stored and nothing in memory: the loaded document is empty, so
    // the project has no Spaces and the connection is refused. The old code
    // reached the same verdict by a different route; keeping it pinned means
    // the rewrite did not turn "no answer" into "yes".
    const client = await connect(DOCUMENT_DOC);

    expect(client.authenticated).toBe(false);
  });

  it("puts back a meta doc it loaded, once the handshake has been answered", async () => {
    // A document loaded with no connection is never unloaded on its own:
    // `unloadDocument` is only reached from a closing client connection or a
    // finishing store. Whoever loads it has to put it back, or every project
    // whose check had to load one leaks a document — and `Server.destroy()`,
    // which waits for `getDocumentsCount()` to reach zero, never returns.
    stored.set(META_DOC, storedMetaWith([SID]));

    const client = await connect(DOCUMENT_DOC);
    expect(client.authenticated).toBe(true);

    // The return is scheduled, not awaited, so it lands after the answer.
    await vi.waitFor(
      () => {
        expect(server.documents.has(META_DOC)).toBe(false);
      },
      { timeout: 5_000 },
    );
  });

  it("reaches the real storage read for the meta doc — what seeding hangs off", async () => {
    // The load is the real one, so the check's path runs through
    // `onLoadDocument` and out to the storage read. In production that read is
    // `fetchDoc`, and `lazySeedMeta` hangs off it: when there is no stored row
    // it creates the project's first Space. Nothing defends against that — it
    // is the same seed the project's own first meta-doc load would perform, it
    // is idempotent, and a member reaching this path could have triggered it by
    // opening the project. What matters is that it is KNOWN to happen.
    //
    // What is pinned here is that the check does reach that entry point. The
    // seeding itself does NOT run in this case and cannot: injecting `fetch`
    // replaces `fetchDoc` wholesale (`persistence.ts`: `deps.fetch ?? fetchDoc`),
    // and `lazySeedMeta` lives inside the replaced function. Asserting on the
    // seed would need the real repo and a database.
    const seeded: string[] = [];
    server = createLiveServer({
      extensions: [
        createPersistenceExtension({
          fetch: async ({ documentName }: { documentName: string }) => {
            seeded.push(documentName);
            return stored.get(documentName) ?? null;
          },
        }),
      ],
      onAuthenticate: createAuthHook({
        redis: {} as never,
        // The ceiling is not this suite's subject. It used to say `0`, which
        // meant "unlimited" back when this was a constant; zero is now a real
        // zero (#88), so say the intent with a number nobody reaches.
        resolveConnectionLimit: async (): Promise<number> => 1000,
        countConnections: async (): Promise<number> => 0,
      }),
    });

    await connect(DOCUMENT_DOC);

    // The check reached the storage read for the META doc — the same entry
    // point `lazySeedMeta` hangs off in production.
    expect(seeded).toContain(META_DOC);
  });

  it("answers the handshake without waiting for the unload to finish", async () => {
    // In production the unload costs about a second: the check's own
    // `unloadDocument` call runs `beforeUnloadDocument`, and
    // `@hocuspocus/extension-redis` delays that hook by `disconnectDelay`
    // (1000ms, `hocuspocus-redis.cjs:48`) so peers get the last sync. That is
    // housekeeping — the person waiting on a handshake must not pay for it.
    //
    // THE COST HAS TO BE STAGED HERE, or this case cannot fail. The server
    // built in `beforeEach` carries no Redis extension, so its unload is
    // instantaneous and awaiting it would cost nothing measurable — the
    // assertion would hold either way. Verified by mutation: with the shared
    // server, changing `unloadAfterReading` into `await instance.unload…`
    // left all eight cases green. So this case builds its own server with an
    // extension that makes the unload take a second, which is what the Redis
    // extension does in production.
    //
    // Whether an arriving client cancels a pending unload is Hocuspocus's
    // guarantee, not ours: `unloadDocument` re-checks `shouldUnloadDocument`
    // at the start and again mid-flight. What IS ours is that the answer does
    // not wait, and that is what this measures.
    const UNLOAD_COST_MS = 1000;
    server = createLiveServer({
      extensions: [
        createPersistenceExtension({
          fetch: async ({ documentName }: { documentName: string }) =>
            stored.get(documentName) ?? null,
        }),
        {
          beforeUnloadDocument: async (): Promise<void> => {
            await new Promise((resolve) => setTimeout(resolve, UNLOAD_COST_MS));
          },
        },
      ],
      onAuthenticate: createAuthHook({
        redis: {} as never,
        // The ceiling is not this suite's subject. It used to say `0`, which
        // meant "unlimited" back when this was a constant; zero is now a real
        // zero (#88), so say the intent with a number nobody reaches.
        resolveConnectionLimit: async (): Promise<number> => 1000,
        countConnections: async (): Promise<number> => 0,
      }),
    });
    stored.set(META_DOC, storedMetaWith([SID]));

    const started = process.hrtime.bigint();
    const client = await connect(DOCUMENT_DOC);
    const answeredInMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(client.authenticated).toBe(true);
    // Half the unload's own cost: an awaited unload cannot come in under this.
    expect(answeredInMs).toBeLessThan(UNLOAD_COST_MS / 2);
  });
});
