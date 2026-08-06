// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The ceilings that close a WHOLE socket, against a real listening server
 * driven by a real WebSocket client.
 *
 * Why they are one subject rather than four. One browser tab holds ONE socket
 * per project and puts every document it needs on it: the meta doc plus one
 * per open Space tab, and a member who has never closed a tab has every Space
 * open because the tab list is seeded from the full Space directory. The
 * library's per-socket ceilings are calibrated for one document per socket,
 * which is the opposite. Raise one of them and the next one down still fires,
 * with the same close code 4205 and the same symptom — a socket that dies and
 * reconnects into the identical wall. So they are set from ONE declared
 * number and tested together; a ceiling raised alone is not a fix.
 *
 * The library terminates a socket in four places (hocuspocus-server.esm.js:
 * 819, 886 twice, 958). Measured against a 1000-document socket carrying the
 * frames a real client sends:
 *
 *   pending documents      default 100    fires first without config
 *   queued frame count     default 1000   fires at ~500 documents
 *   queued frame bytes     default 5 MB   ~390 KB used, 13x of headroom
 *   idle timeout           default 60 s   client heartbeats every 15 s
 *
 * The first two are derived from the declared number; the last two are left
 * at their defaults, and the cases below pin the measurements that justify
 * leaving them.
 *
 * Holding a socket at a chosen pending count needs an `onAuthenticate` that
 * never settles — not a stand-in for slow auth, but the only way to observe
 * the peak rather than a moving number.
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import { Server } from "@hocuspocus/server";
import { getCollabConfig } from "@collab/config.js";
import {
  socketCeilings,
  QUEUED_FRAMES_PER_DOCUMENT,
} from "@collab/infra/socket-ceilings.js";

/** Outer message type of an auth frame, as it appears on the wire. */
const WIRE_AUTH = 2;

/** Outer message type of a sync frame. */
const WIRE_SYNC = 0;

/** Outer message type of an awareness frame. */
const WIRE_AWARENESS = 1;

/** Sub-type of the auth frame a client opens a document with. */
const AUTH_SUB_TOKEN = 0;

/** Close code the library uses when a socket exceeds a per-socket limit. */
const RESET_CONNECTION_CODE = 4205;

/**
 * Bytes one pending document holds in the queue, measured by encoding the
 * frames a real client sends: sync-step-one for a document with content (99)
 * plus an awareness update carrying a user and a cursor (300).
 */
const MEASURED_QUEUED_BYTES_PER_DOCUMENT = 399;

/** The library's queued-byte ceiling, which this project leaves alone. */
const LIBRARY_QUEUE_BYTE_CEILING = 5 * 1024 * 1024;

let running: Server | undefined;
let client: WebSocket | undefined;

afterEach(async () => {
  client?.terminate();
  client = undefined;
  await running?.destroy();
  running = undefined;
});

/** One frame addressed to a document, with an optional sub-type and token. */
function frame(docName: string, type: number, sub?: number): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, docName);
  encoding.writeVarUint(encoder, type);
  if (sub !== undefined) encoding.writeVarUint(encoder, sub);
  if (type === WIRE_AUTH) encoding.writeVarString(encoder, "__cookie_auth__");
  return encoding.toUint8Array(encoder);
}

/**
 * Start a server whose authentication never settles, so every document a
 * client opens stays pending and the peak is observable.
 * @param ceilings - The per-socket limits to run with; omitted means the
 *   library's own defaults, which is what production inherited before these
 *   values were derived from `config/collab.yaml`.
 * @returns The port it is listening on.
 */
async function serverHoldingAuth(ceilings?: {
  maxPendingDocuments: number;
  maxUnauthenticatedQueueMessages: number;
}): Promise<number> {
  const server = new Server({
    port: 0,
    quiet: true,
    ...(ceilings ?? {}),
    onAuthenticate: () => new Promise<never>(() => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  running = server;
  await server.listen();
  return server.address.port;
}

/**
 * Open documents on one socket the way a real client does, and report how the
 * socket ended up.
 * @param port - Port the server is listening on.
 * @param documents - How many documents to request.
 * @param full - True sends the auth, sync and awareness frames a real client
 *   sends per document; false sends only the auth frame.
 * @returns The close code if the server closed the socket, else null.
 */
async function openDocuments(
  port: number,
  documents: number,
  full: boolean,
): Promise<number | null> {
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

  for (let i = 0; i < documents; i += 1) {
    if (socket.readyState !== WebSocket.OPEN) break;
    const name = i === 0 ? "project-many/meta" : `project-many/canvas-${i}`;
    socket.send(frame(name, WIRE_AUTH, AUTH_SUB_TOKEN));
    if (full) {
      socket.send(frame(name, WIRE_SYNC, 0));
      socket.send(frame(name, WIRE_AWARENESS));
    }
  }
  // Long enough for the frames to be read and the close, if any, to arrive.
  await new Promise((resolve) => setTimeout(resolve, 700));
  return closeCode;
}

/** The ceilings production runs with, derived from the declared number. */
function productionCeilings(): ReturnType<typeof socketCeilings> {
  return socketCeilings(getCollabConfig().max_documents_per_socket);
}

describe("the ceilings that close a whole socket", () => {
  it("holds a full project's documents with the frames a real client sends", async () => {
    // The case the whole subject exists for. Sending only auth frames passes
    // even against the library's queued-frame default, which is exactly how
    // that ceiling stayed hidden while the one above it was raised.
    const port = await serverHoldingAuth(productionCeilings());

    expect(
      await openDocuments(port, getCollabConfig().max_documents_per_socket, true),
    ).toBeNull();
  });

  it("is capped by the library below a full project even when only auth frames go out", async () => {
    const port = await serverHoldingAuth();

    expect(await openDocuments(port, 150, false)).toBe(RESET_CONNECTION_CODE);
  });

  it("is capped by the library at half that once the sync and awareness frames ride along", async () => {
    // Characterises the second ceiling, the one a raised first ceiling hides.
    // 520 documents is under any pending-document limit worth configuring and
    // still dies, because each document queues two frames against a separate
    // count of 1000.
    const port = await serverHoldingAuth({
      maxPendingDocuments: getCollabConfig().max_documents_per_socket,
      maxUnauthenticatedQueueMessages: 1000,
    });

    expect(await openDocuments(port, 520, true)).toBe(RESET_CONNECTION_CODE);
  });
});

describe("deriving the ceilings from one declared number", () => {
  it("moves both ceilings together", () => {
    const small = socketCeilings(10);
    const large = socketCeilings(1000);

    expect(large.maxPendingDocuments).toBeGreaterThan(small.maxPendingDocuments);
    expect(large.maxUnauthenticatedQueueMessages).toBeGreaterThan(
      small.maxUnauthenticatedQueueMessages,
    );
  });

  it("gives the frame count room for every frame a document queues", () => {
    // Two frames per document measured today; the factor is above that so a
    // client replaying buffered work on reconnect does not sit on the line.
    const documents = 1000;
    const ceilings = socketCeilings(documents);

    expect(ceilings.maxPendingDocuments).toBe(documents);
    expect(ceilings.maxUnauthenticatedQueueMessages).toBeGreaterThanOrEqual(
      documents * QUEUED_FRAMES_PER_DOCUMENT,
    );
  });

  it("keeps the frame count from outgrowing the byte ceiling it does not control", () => {
    // The ordering that lets the byte ceiling stay at its default: bytes are
    // what actually bound memory, so the frame count must never be the looser
    // of the two. If a future frame grows, this is what goes red.
    const ceilings = socketCeilings(getCollabConfig().max_documents_per_socket);
    const worstCaseBytes =
      ceilings.maxUnauthenticatedQueueMessages * MEASURED_QUEUED_BYTES_PER_DOCUMENT;

    expect(worstCaseBytes).toBeLessThan(LIBRARY_QUEUE_BYTE_CEILING);
  });
});
