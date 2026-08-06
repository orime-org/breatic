// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pins the ceiling on how many documents one socket may open at once,
 * against a real listening server driven by a real WebSocket client.
 *
 * Why this needs a live server: the limit lives inside the library's own
 * message loop, and tripping it does not refuse the document — it closes the
 * WHOLE socket with close code 4205. Nothing short of a real socket observes
 * that, and nothing in our code would report it.
 *
 * Why the limit matters to us at all: one browser tab holds one socket per
 * project and puts every document it needs on it — the meta doc plus one per
 * open Space tab. A member who has never closed a tab has every Space open,
 * because `ensureOpenTabList` seeds the list from the full Space directory the
 * first time they open the project. So the peak is the project's Space count,
 * and nothing caps that. The library's default of 100 assumes one document per
 * socket, which is the opposite of our shape.
 *
 * The count is of documents awaiting AUTHENTICATION, so the way to hold a
 * socket at a chosen pending count is an `onAuthenticate` that never settles.
 * That is what the never-resolving hook below is for — not a stand-in for slow
 * auth, but the only way to observe the peak rather than a moving number.
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import { Server } from "@hocuspocus/server";
import { getCollabConfig } from "@collab/config.js";

/** Outer message type of an auth frame, as it appears on the wire. */
const WIRE_AUTH = 2;

/** Sub-type of the auth frame a client opens a document with. */
const AUTH_SUB_TOKEN = 0;

/** Close code the library uses when a socket exceeds a per-socket limit. */
const RESET_CONNECTION_CODE = 4205;

/**
 * Documents opened per case. Above the library's own default of 100, so a
 * server that inherited that default drops the socket and a server carrying
 * our configured value does not.
 */
const DOCUMENTS = 150;

let running: Server | undefined;
let client: WebSocket | undefined;

afterEach(async () => {
  client?.terminate();
  client = undefined;
  await running?.destroy();
  running = undefined;
});

/** The first frame a client sends for a document, which opens it. */
function authFrame(docName: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, docName);
  encoding.writeVarUint(encoder, WIRE_AUTH);
  encoding.writeVarUint(encoder, AUTH_SUB_TOKEN);
  encoding.writeVarString(encoder, "__cookie_auth__");
  return encoding.toUint8Array(encoder);
}

/**
 * Start a server whose authentication never settles, so every document a
 * client opens stays pending and the peak count is observable.
 * @param maxPendingDocuments - The limit to run with; omitted means the
 *   library's own default, which is what production inherited before this
 *   value moved into `config/collab.yaml`.
 * @returns The port it is listening on.
 */
async function serverHoldingAuth(maxPendingDocuments?: number): Promise<number> {
  const server = new Server({
    port: 0,
    quiet: true,
    ...(maxPendingDocuments === undefined ? {} : { maxPendingDocuments }),
    onAuthenticate: () => new Promise<never>(() => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  running = server;
  await server.listen();
  return server.address.port;
}

/**
 * Open one socket, request `DOCUMENTS` documents on it, and report how the
 * socket ended up.
 * @param port - Port the server is listening on.
 * @returns The close code if the server closed the socket, or null if it is
 *   still open once every frame has been sent.
 */
async function openManyDocuments(port: number): Promise<number | null> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  client = socket;
  let closeCode: number | null = null;
  socket.on("close", (code: number) => {
    closeCode = code;
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });

  for (let i = 0; i < DOCUMENTS; i += 1) {
    if (socket.readyState !== WebSocket.OPEN) break;
    socket.send(authFrame(i === 0 ? "project-many/meta" : `project-many/canvas-${i}`));
  }
  // Long enough for the frames to be read and the close, if any, to arrive.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return closeCode;
}

describe("documents pending authentication on one socket", () => {
  it("is capped by the library at a number below what one project needs", async () => {
    // Characterises the default this project cannot use. If a future version
    // drops the limit or raises it past DOCUMENTS, this goes red and the
    // configured value below can be reconsidered rather than carried blindly.
    const port = await serverHoldingAuth();

    expect(await openManyDocuments(port)).toBe(RESET_CONNECTION_CODE);
  });

  it("is raised by our configuration to hold a whole project's documents", async () => {
    const port = await serverHoldingAuth(getCollabConfig().max_pending_documents);

    expect(await openManyDocuments(port)).toBeNull();
  });

  it("is configured above the documents a large project puts on one socket", () => {
    // The value itself, not the plumbing: lowering it back under DOCUMENTS in
    // `config/collab.yaml` would restore the drop the tests above describe.
    expect(getCollabConfig().max_pending_documents).toBeGreaterThan(DOCUMENTS);
  });
});
