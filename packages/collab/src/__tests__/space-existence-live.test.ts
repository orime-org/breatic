// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The Space-existence check against a REAL Hocuspocus server (#26).
 *
 * `auth.test.ts` calls the hook directly and hands it a hand-written
 * `Map<string, Y.Doc>` for `instance.documents`. That map and the
 * `LoadedDocuments` interface it satisfies were written in the same commit,
 * so between them they can only prove that the hook does what the hook was
 * written to do. What they cannot reach is the claim the fix actually rests
 * on: that at the moment a content doc's handshake arrives, the running
 * framework really is holding this project's meta doc in
 * `instance.documents`, and that the object it holds answers `getMap`.
 *
 * So these run the framework. A client opens the meta doc the way a browser
 * does, the meta doc is then changed IN MEMORY ONLY — exactly what
 * `space:create` and `space:delete` do — and the Postgres side is staged to
 * disagree. Whichever of the two answers the handshake is then visible in
 * the outcome, with nothing mocked in between.
 *
 * Staging Postgres to disagree is not an artificial setup. It IS the window
 * the bug lived in: the create path triggers no store of its own, so the
 * `yjs_documents` row trails the in-memory doc by up to one
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

/**
 * The bytes Postgres hands back for the meta doc — the state the fallback
 * branch would decide from.
 * @param ids - Space ids the stored row claims exist.
 * @returns Encoded Yjs state for the meta doc.
 */
function persistedMetaState(ids: string[]): Buffer {
  const doc = new Y.Doc();
  const spaces = doc.getMap("spaces");
  for (const id of ids) {
    const entry = new Y.Map<unknown>();
    spaces.set(id, entry);
    entry.set("id", id);
  }
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

/**
 * Change the meta doc this process holds, without touching Postgres — the
 * same reach `space-rpc.ts` uses for `space:create` and `space:delete`.
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
  server = createLiveServer({
    onAuthenticate: createAuthHook({
      // The hook only forwards this to core's session store, which is mocked.
      redis: {} as never,
      maxConnectionsPerDoc: 0,
      countConnections: async (): Promise<number> => 0,
    }),
  });
});

afterEach(() => {
  for (const client of clients) client.close();
});

describe("Space existence over a live server", () => {
  it("admits a Space that only the in-memory meta doc knows about", async () => {
    // Postgres is one store tick behind and still lists no Spaces at all.
    fetchDocDataMock.mockResolvedValue(persistedMetaState([]));
    // The browser holds the meta doc open; that is what puts it in
    // `instance.documents` and it is the reason a content-doc handshake can
    // never arrive before the meta doc is loaded — the tab list the client
    // opens content docs from lives in this very document.
    const metaClient = await connect(META_DOC);
    expect(metaClient.authenticated).toBe(true);

    // `space:create` in miniature: the id lands in memory and is broadcast,
    // and nothing is written to `yjs_documents`.
    await mutateLiveMetaDoc((live) => {
      const entry = new Y.Map<unknown>();
      live.getMap("spaces").set(SID, entry);
      entry.set("id", SID);
    });

    const client = await connect(DOCUMENT_DOC);

    expect(client.authenticated).toBe(true);
  });

  it("refuses a Space the in-memory meta doc has dropped, while Postgres still lists it", async () => {
    // The mirror image, and the half a browser cannot be made to reproduce:
    // after `space:delete` the id is gone from memory at once while the row
    // keeps listing it until the next store tick.
    fetchDocDataMock.mockResolvedValue(persistedMetaState([SID]));
    const metaClient = await connect(META_DOC);
    expect(metaClient.authenticated).toBe(true);

    await mutateLiveMetaDoc((live) => {
      live.getMap("spaces").delete(SID);
    });

    const client = await connect(DOCUMENT_DOC);

    expect(client.authenticated).toBe(false);
  });

  it("decides from Postgres when this process holds no meta doc for the project", async () => {
    // No client has opened the meta doc, so `instance.documents` has nothing
    // for it and the fallback is the only branch left. This is the pre-#26
    // behaviour, kept intact.
    fetchDocDataMock.mockResolvedValue(persistedMetaState([SID]));

    const client = await connect(DOCUMENT_DOC);

    expect(client.authenticated).toBe(true);
    expect(fetchDocDataMock).toHaveBeenCalledWith(META_DOC);
  });
});
