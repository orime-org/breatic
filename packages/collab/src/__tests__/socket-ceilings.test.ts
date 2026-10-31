// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ceilings that close a WHOLE socket, against a real listening server
 * driven by a real WebSocket client.
 *
 * Why they are one subject rather than four. One browser tab holds ONE socket
 * per project and puts every document it needs on it: the meta doc plus one
 * per open Space tab. A first visit opens one Space, and nothing in the
 * product stops a member going on to open every Space there is. The
 * library's per-socket ceilings are calibrated for one document per socket,
 * which is the opposite. Raise one of them and the next one down still fires,
 * with the same close code 4205 and the same symptom — a socket that dies and
 * reconnects into the identical wall. So they are set from ONE number — a
 * project's Space cap plus its meta doc — and tested together; a ceiling
 * raised alone is not a fix.
 *
 * `@hocuspocus/server` 4.6.0 closes a socket at four limits:
 *
 *   pending documents      default 100    fires first without config
 *   queued frame count     default 1000   fires at ~500 documents
 *   queued frame bytes     default 5 MB   left alone
 *   idle timeout           default 60 s   client heartbeats every 15 s
 *
 * The pending-document count is derived from a full project; the frame count
 * from the byte ceiling and what each queued frame keeps on top of its bytes
 * (infra/socket-ceilings.ts); the byte ceiling and the idle timeout are left
 * at their defaults, and the last case below pins the heartbeat that
 * justifies leaving the timeout.
 *
 * Holding a socket at a chosen pending count needs an `onAuthenticate` that
 * never settles — not a stand-in for slow auth, but the only way to observe
 * the peak rather than a moving number.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import fc from "fast-check";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, outdatedTimeout } from "y-protocols/awareness";
import type { Hocuspocus } from "@hocuspocus/server";
import { Server, defaultConfiguration } from "@hocuspocus/server";
import {
  SOCKET_CEILINGS,
  DOCUMENTS_PER_SOCKET,
} from "@collab/infra/socket-ceilings.js";
import {
  SYNC,
  awarenessFrame,
  createLiveServer,
  decodeServerFrame,
  syncFrame,
  waitFor,
} from "./helpers/live-hocuspocus.js";

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
 *   library's own defaults.
 * @returns The port it is listening on.
 */
async function serverHoldingAuth(
  ceilings?: Partial<typeof SOCKET_CEILINGS>,
): Promise<number> {
  const server = new Server({
    port: 0,
    stopOnSignals: false,
    // Bound to the address the case connects to: a port the OS hands out for
    // every interface can be held on 127.0.0.1 by another local server, which
    // then takes the connection and answers 404.
    address: "127.0.0.1",
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
 * @param backlogFrames - Further queued frames spread across the documents,
 *   standing in for a client with buffered work to replay. This is what the
 *   headroom absorbs.
 * @returns The close code if the server closed the socket, else null.
 */
async function openDocuments(
  port: number,
  documents: number,
  full: boolean,
  backlogFrames = 0,
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
  for (let i = 0; i < backlogFrames; i += 1) {
    if (socket.readyState !== WebSocket.OPEN) break;
    const doc = i % documents;
    const name = doc === 0 ? "project-many/meta" : `project-many/canvas-${doc}`;
    socket.send(frame(name, WIRE_SYNC, 0));
  }
  // Long enough for the frames to be read and the close, if any, to arrive.
  await new Promise((resolve) => setTimeout(resolve, 700));
  return closeCode;
}

describe("the ceilings that close a whole socket", () => {
  it("holds a full project's documents with the frames a real client sends", async () => {
    // The case the whole subject exists for. Sending only auth frames passes
    // even against the library's queued-frame default, which is exactly how
    // that ceiling stayed hidden while the one above it was raised.
    const port = await serverHoldingAuth(SOCKET_CEILINGS);

    expect(await openDocuments(port, DOCUMENTS_PER_SOCKET, true)).toBeNull();
  });

  it("is capped by the library below a full project even when only auth frames go out", async () => {
    const port = await serverHoldingAuth();

    expect(await openDocuments(port, 150, false)).toBe(RESET_CONNECTION_CODE);
  });

  it("keeps a full project's socket open through a long offline backlog", async () => {
    const port = await serverHoldingAuth(SOCKET_CEILINGS);

    expect(await openDocuments(port, DOCUMENTS_PER_SOCKET, true, 3000)).toBeNull();
  });

  it("is capped by the library at half that once the sync and awareness frames ride along", async () => {
    // Characterises the second ceiling, the one a raised first ceiling hides.
    // 520 documents is under any pending-document limit worth configuring and
    // still dies, because each document queues two frames against a separate
    // count of 1000.
    const port = await serverHoldingAuth({
      maxPendingDocuments: 1000,
      maxUnauthenticatedQueueMessages: defaultConfiguration.maxUnauthenticatedQueueMessages,
    });

    expect(await openDocuments(port, 520, true)).toBe(RESET_CONNECTION_CODE);
  });
});

describe("deriving the ceilings from a project's Space cap", () => {
  it("sets the pending-document ceiling to a full project's documents", () => {
    expect(SOCKET_CEILINGS.maxPendingDocuments).toBe(DOCUMENTS_PER_SOCKET);
  });

  it("runs with 201 pending documents and 16333 queued frames", () => {
    // Pinned as values: the derivation can move either one without any
    // relation between them breaking, and the startup log prints these two.
    expect(SOCKET_CEILINGS).toEqual({
      maxPendingDocuments: 201,
      maxUnauthenticatedQueueMessages: 16333,
    });
  });

  it("keeps the client's heartbeat well inside the server's silence timeout", () => {
    // The silence timeout closes a socket that has sent nothing for
    // `timeout`. Since hocuspocus 4 the
    // server no longer pings, so the only thing holding a socket open while
    // nobody types is the awareness heartbeat: y-protocols re-announces local
    // state every `outdatedTimeout / 2`. Both numbers belong to libraries, so
    // this reads them instead of repeating them — either one moving is
    // exactly what would make leaving `timeout` at its default wrong.
    const heartbeatPeriodMs = outdatedTimeout / 2;

    expect(heartbeatPeriodMs * 2).toBeLessThan(defaultConfiguration.timeout);
  });
});

describe("a frame queued before authentication", () => {
  it("keeps only its own bytes, not the read buffer it arrived in", () => {
    // ws hands each frame over as a view into the socket read chunk (up to
    // 64 KB). Queued as that view, one 51-byte frame keeps the whole chunk
    // alive, and a client padding every read with ping frames turns the
    // queued-frame ceiling into a gigabyte. The patch in
    // `patches/@hocuspocus__server@4.6.0.patch` copies the frame on the way
    // into the queue.
    const { conn: connection } = open(holdingHocuspocus([]), stubRequest("/"));
    const payload = frame("project-q/meta", WIRE_SYNC, 0);
    const readChunk = new Uint8Array(64 * 1024);
    readChunk.set(payload, 1000);
    const view = readChunk.subarray(1000, 1000 + payload.byteLength);

    connection.handleMessage(view);
    const queued = connection.incomingMessageQueue["project-q/meta"]?.[0];
    connection.handleClose();

    expect(queued).toEqual(payload);
    expect(queued?.buffer.byteLength).toBe(payload.byteLength);
  });
});

/** Close code for a document whose first frame threw (`Unauthorized`). */
const UNAUTHORIZED_CODE = 4401;

/** A request in the shape crossws hands over: the URL exactly as it was built. */
type StubRequest = { url?: string; headers: Headers };

/** A socket that records every frame the server sends and every close it asks for. */
type RecordingSocket = {
  readyState: number;
  sent: Uint8Array[];
  closes: Array<[number | undefined, string | undefined]>;
  send: (data: Uint8Array, callback?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
  ping: () => void;
};

/** What a test reads off a connection made through `handleConnection`. */
type ParsedConnection = {
  handleMessage: (data: Uint8Array) => void;
  hookPayloads: Record<string, { requestParameters: URLSearchParams }>;
  incomingMessageQueue: Record<string, Uint8Array[]>;
  handleClose: (event?: unknown) => void;
};

/** One hook call as a recording hook saw it. */
type Seen = {
  hook: string;
  documentName: string;
  params: URLSearchParams;
  request: unknown;
};

/**
 * A request as crossws builds it. `new Request(url)` would normalise the URL
 * (or throw on it), and the point is what reaches `getParameters` unchanged.
 * @param url - The URL; undefined leaves the request without one.
 * @returns The request.
 */
function stubRequest(url?: string): StubRequest {
  return url === undefined ? { headers: new Headers() } : { url, headers: new Headers() };
}

/**
 * A socket that records instead of transmitting.
 * @returns The socket.
 */
function recordingSocket(): RecordingSocket {
  const socket: RecordingSocket = {
    readyState: 1,
    sent: [],
    closes: [],
    send: (data, callback) => {
      socket.sent.push(data);
      callback?.();
    },
    close: (code, reason) => {
      socket.closes.push([code, reason]);
    },
    ping: () => {},
  };
  return socket;
}

/**
 * Open a connection the way the server does on an upgrade, without a listener.
 * @param hocuspocus - The instance to connect to.
 * @param request - The request the connection is opened with.
 * @returns The socket and the connection.
 */
function open(
  hocuspocus: Hocuspocus,
  request: StubRequest,
): { socket: RecordingSocket; conn: ParsedConnection } {
  const socket = recordingSocket();
  const conn = hocuspocus.handleConnection(
    socket,
    request as never,
  ) as unknown as ParsedConnection;
  return { socket, conn };
}

/**
 * The upstream body of `getParameters`, before the patch: what every parse
 * must still equal.
 * @param url - The request URL.
 * @returns A fresh parse.
 */
function oracle(url: string): URLSearchParams {
  if (!url) return new URLSearchParams();
  return url.includes("://") ? new URL(url).searchParams : new URLSearchParams(url.split("?")[1] || "");
}

/**
 * Whether the upstream parse of a URL throws.
 * @param url - The request URL.
 * @returns True when it throws.
 */
function oracleThrows(url: string): boolean {
  try {
    oracle(url);
    return false;
  } catch {
    return true;
  }
}

/**
 * The entries of a parse, comparable with `toEqual`.
 * @param params - The parse.
 * @returns Its key/value pairs in order.
 */
function entriesOf(params: URLSearchParams): Array<[string, string]> {
  return [...params.entries()];
}

/**
 * A hook that records what it is handed.
 * @param seen - Where calls are recorded.
 * @param hook - The hook's name.
 * @returns The hook.
 */
function recordInto(
  seen: Seen[],
  hook: string,
): (data: { documentName: string; requestParameters: URLSearchParams; request?: unknown }) => Promise<void> {
  return async (data) => {
    seen.push({ hook, documentName: data.documentName, params: data.requestParameters, request: data.request });
  };
}

/**
 * An instance at the production ceilings whose authentication records what it
 * is handed and never settles, so every document stays pending.
 * @param seen - Where `onAuthenticate` calls are recorded.
 * @returns The instance.
 */
function holdingHocuspocus(seen: Seen[]): Hocuspocus {
  const record = recordInto(seen, "onAuthenticate");
  return createLiveServer({
    ...SOCKET_CEILINGS,
    onAuthenticate: (data: { documentName: string; requestParameters: URLSearchParams; request: unknown }) => {
      void record(data);
      return new Promise<never>(() => {});
    },
  });
}

const QUERY_URL = "http://collab.test/ws?a=1&b=2";
const PLAIN_URL = "http://collab.test/ws";

describe("request parameters of one connection", () => {
  // Every document a socket opens gets a hook payload that holds the parsed
  // request URL until its authentication fails or its connection closes, with
  // up to 201 pending per socket. Parsed once per document, a client-chosen
  // URL is multiplied by that count; the patch in
  // `patches/@hocuspocus__server@4.6.0.patch` parses it once per request
  // (inner#1589). The cases follow the inner#1589 test spec.

  it("hands two pending documents the parse the connection keeps for them", async () => {
    const seen: Seen[] = [];
    const { socket, conn } = open(holdingHocuspocus(seen), stubRequest(QUERY_URL));

    conn.handleMessage(frame("u01-a", WIRE_AUTH, AUTH_SUB_TOKEN));
    conn.handleMessage(frame("u01-b", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => seen.length === 2, "two authentications");
    const kept = [conn.hookPayloads["u01-a"]?.requestParameters, conn.hookPayloads["u01-b"]?.requestParameters];
    conn.handleClose();

    expect(seen[1]?.params).toBe(seen[0]?.params);
    expect(kept[0]).toBe(seen[0]?.params);
    expect(kept[1]).toBe(seen[0]?.params);
    expect(entriesOf(seen[0]!.params)).toEqual([["a", "1"], ["b", "2"]]);
    expect(socket.closes).toEqual([]);
  });

  it("shares one parse across documents that only ever sent a first sync frame", async () => {
    const seen: Seen[] = [];
    const { socket, conn } = open(holdingHocuspocus(seen), stubRequest(QUERY_URL));

    for (const doc of ["u02-a", "u02-b", "u02-c"]) conn.handleMessage(frame(doc, WIRE_SYNC, SYNC.step1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kept = Object.values(conn.hookPayloads).map((p) => p.requestParameters);
    conn.handleClose();

    expect(kept).toHaveLength(3);
    expect(new Set(kept).size).toBe(1);
    expect(entriesOf(kept[0]!)).toEqual([["a", "1"], ["b", "2"]]);
    expect(seen).toEqual([]);
    expect(socket.closes).toEqual([]);
  });

  it("keeps one parse for a full project's pending documents", async () => {
    const url = `http://collab.test/ws?${Array.from({ length: 300 }, (_, i) => `p${i}=${i}`).join("&")}`;
    const seen: Seen[] = [];
    const { socket, conn } = open(holdingHocuspocus(seen), stubRequest(url));

    for (let i = 0; i < DOCUMENTS_PER_SOCKET; i += 1) {
      conn.handleMessage(frame(`u03-${i}`, WIRE_AUTH, AUTH_SUB_TOKEN));
    }
    await waitFor(() => seen.length === DOCUMENTS_PER_SOCKET, "every document authenticating");
    const kept = Object.values(conn.hookPayloads).map((p) => p.requestParameters);
    conn.handleClose();

    expect(new Set(seen.map((s) => s.params)).size).toBe(1);
    expect(kept).toHaveLength(DOCUMENTS_PER_SOCKET);
    for (const p of kept) expect(p).toBe(seen[0]!.params);
    expect(entriesOf(seen[0]!.params)).toEqual(entriesOf(oracle(url)));
    expect(entriesOf(seen[0]!.params)).toHaveLength(300);
    expect(socket.closes).toEqual([]);
  });

  it.each([
    ["a query smuggled in through Host", "http://a?k=1/ws", [["k", "1/ws"]]],
    ["a path the URL parser rewrites", `http://collab.test/ws/${'"'.repeat(100)}`, []],
    ["an upper-case Host", `http://${"A".repeat(100)}/ws`, []],
    ["percent escapes, broken and valid", "http://collab.test/ws?x=%zz&y=%C3%A9", [["x", "%zz"], ["y", "é"]]],
  ])("shares one parse across pending documents for %s", async (_label, url, expected) => {
    const seen: Seen[] = [];
    const { conn } = open(holdingHocuspocus(seen), stubRequest(url));

    conn.handleMessage(frame("u04-a", WIRE_AUTH, AUTH_SUB_TOKEN));
    conn.handleMessage(frame("u04-b", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => seen.length === 2, "two authentications");
    conn.handleClose();

    expect(seen[1]?.params).toBe(seen[0]?.params);
    expect(entriesOf(seen[0]!.params)).toEqual(expected);
    expect(entriesOf(seen[0]!.params)).toEqual(entriesOf(oracle(url)));
  });

  it.each([
    ["a query string", QUERY_URL],
    ["the plain production URL", PLAIN_URL],
  ])("hands every hook on the connection the same parse, for %s", async (_label, url) => {
    const seen: Seen[] = [];
    const hooks = [
      "onConnect", "onAuthenticate", "connected", "onCreateDocument", "onLoadDocument",
      "afterLoadDocument", "beforeHandleMessage", "afterHandleMessage", "onChange",
      "beforeHandleAwareness", "onDisconnect",
    ];
    const recorders = Object.fromEntries(hooks.map((hook) => [hook, recordInto(seen, hook)]));
    // 4.6.0 wires every configuration hook into its internal extension except
    // `onCreateDocument`, which only an extension receives.
    const hocuspocus = createLiveServer({
      ...SOCKET_CEILINGS,
      ...recorders,
      extensions: [{ onCreateDocument: recorders.onCreateDocument }],
    });
    const { socket, conn } = open(hocuspocus, stubRequest(url));
    const saw = (hook: string, doc: string): boolean =>
      seen.some((s) => s.hook === hook && s.documentName === doc);

    conn.handleMessage(frame("u05-a", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => saw("connected", "u05-a"), "u05-a connected");
    const edit = new Y.Doc();
    edit.getMap("m").set("k", 1);
    conn.handleMessage(syncFrame("u05-a", WIRE_SYNC, SYNC.update, Y.encodeStateAsUpdate(edit)));
    await waitFor(() => saw("onChange", "u05-a"), "u05-a onChange");
    const presence = new Awareness(new Y.Doc());
    presence.setLocalState({ name: "u05" });
    conn.handleMessage(awarenessFrame("u05-a", encodeAwarenessUpdate(presence, [presence.clientID])));
    presence.destroy();
    await waitFor(() => saw("beforeHandleAwareness", "u05-a"), "u05-a awareness");
    conn.handleMessage(frame("u05-b", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => saw("afterLoadDocument", "u05-b"), "u05-b loaded");
    const closesBeforeClose = [...socket.closes];
    socket.readyState = 3;
    conn.handleClose({ code: 1000, reason: "" });
    await waitFor(() => saw("onDisconnect", "u05-a") && saw("onDisconnect", "u05-b"), "both disconnects");

    expect([...new Set(seen.map((s) => s.hook))].sort()).toEqual([...hooks].sort());
    const first = seen.find((s) => s.hook === "onConnect")!.params;
    for (const s of seen) expect(s.params, `${s.hook} on ${s.documentName}`).toBe(first);
    expect(entriesOf(first)).toEqual(entriesOf(oracle(url)));
    const auths = socket.sent.map(decodeServerFrame).filter((f) => f.type === WIRE_AUTH);
    expect(auths.map((f) => [f.docName, f.authDetail])).toEqual([["u05-a", "read-write"], ["u05-b", "read-write"]]);
    expect(closesBeforeClose).toEqual([]);
  });

  it("gives two connections with the same URL a parse each", async () => {
    const seen: Seen[] = [];
    const hocuspocus = holdingHocuspocus(seen);
    const one = open(hocuspocus, stubRequest(QUERY_URL));
    const other = open(hocuspocus, stubRequest(QUERY_URL));

    one.conn.handleMessage(frame("u06-1a", WIRE_AUTH, AUTH_SUB_TOKEN));
    other.conn.handleMessage(frame("u06-2a", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => seen.length === 2, "one authentication per connection");
    const fromOne = seen.find((s) => s.documentName === "u06-1a")!.params;
    const fromOther = seen.find((s) => s.documentName === "u06-2a")!.params;
    fromOne.append("seen", "1");
    one.conn.handleMessage(frame("u06-1b", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => seen.length === 3, "second document on the first connection");
    const laterOnOne = seen.find((s) => s.documentName === "u06-1b")!.params;
    one.conn.handleClose();
    other.conn.handleClose();

    expect(fromOther).not.toBe(fromOne);
    expect(entriesOf(fromOther)).toEqual([["a", "1"], ["b", "2"]]);
    expect(laterOnOne).toBe(fromOne);
  });

  it.each([
    ["without a url", stubRequest()],
    ["with an empty url", stubRequest("")],
  ])("parses a request %s to empty parameters", async (_label, request) => {
    const seen: Seen[] = [];
    const { socket, conn } = open(holdingHocuspocus(seen), request);

    conn.handleMessage(frame("u07-a", WIRE_AUTH, AUTH_SUB_TOKEN));
    conn.handleMessage(frame("u07-b", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => seen.length === 2, "two authentications");
    conn.handleClose();

    expect(entriesOf(seen[0]!.params)).toEqual([]);
    expect(entriesOf(seen[1]!.params)).toEqual([]);
    expect(socket.closes).toEqual([]);
  });

  it("gives every server-side change without a request its own empty parameters", async () => {
    const seen: Seen[] = [];
    const hocuspocus = createLiveServer({ onChange: recordInto(seen, "onChange") });
    const direct = await hocuspocus.openDirectConnection("u08-doc");

    await direct.transact((doc) => doc.getMap("m").set("k", 1));
    await direct.transact((doc) => doc.getMap("m").set("k", 2));
    await direct.disconnect();

    expect(seen).toHaveLength(2);
    expect(entriesOf(seen[0]!.params)).toEqual([]);
    expect(entriesOf(seen[1]!.params)).toEqual([]);
    expect(seen[1]!.params).not.toBe(seen[0]!.params);
  });

  it("gives each direct connection its own parse though their URLs match", async () => {
    const seen: Seen[] = [];
    const hocuspocus = createLiveServer({ onLoadDocument: recordInto(seen, "onLoadDocument") });

    const a = await hocuspocus.openDirectConnection("u09-a");
    const b = await hocuspocus.openDirectConnection("u09-b");
    await a.disconnect();
    await b.disconnect();

    expect(seen).toHaveLength(2);
    expect(entriesOf(seen[0]!.params)).toEqual([]);
    expect(entriesOf(seen[1]!.params)).toEqual([]);
    expect(seen[1]!.params).not.toBe(seen[0]!.params);
  });

  it("closes on a URL that cannot be parsed, once per document, and keeps nothing", async () => {
    const url = "http://a b/ws";
    expect(() => new URL(url)).toThrow(TypeError);
    const seen: Seen[] = [];
    const hocuspocus = createLiveServer({
      ...SOCKET_CEILINGS,
      onConnect: recordInto(seen, "onConnect"),
      onAuthenticate: recordInto(seen, "onAuthenticate"),
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { socket, conn } = open(hocuspocus, stubRequest(url));

    try {
      conn.handleMessage(frame("u10-a", WIRE_AUTH, AUTH_SUB_TOKEN));
      conn.handleMessage(frame("u10-b", WIRE_AUTH, AUTH_SUB_TOKEN));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const kept = Object.keys(conn.hookPayloads);
      conn.handleClose();

      expect(socket.closes).toEqual([
        [UNAUTHORIZED_CODE, "Unauthorized"],
        [UNAUTHORIZED_CODE, "Unauthorized"],
      ]);
      expect(seen).toEqual([]);
      expect(kept).toEqual([]);
      expect(quiet.mock.calls.map(([err]) => err instanceof TypeError)).toEqual([true, true]);
    } finally {
      quiet.mockRestore();
    }
  });

  it.each([
    ["/ws?a=1&b=2", [["a", "1"], ["b", "2"]]],
    ["/ws", []],
  ])("shares one parse for the relative URL %s", async (url, expected) => {
    const seen: Seen[] = [];
    const { conn } = open(holdingHocuspocus(seen), stubRequest(url));

    conn.handleMessage(frame("u11-a", WIRE_AUTH, AUTH_SUB_TOKEN));
    conn.handleMessage(frame("u11-b", WIRE_AUTH, AUTH_SUB_TOKEN));
    await waitFor(() => seen.length === 2, "two authentications");
    conn.handleClose();

    expect(seen[1]?.params).toBe(seen[0]?.params);
    expect(entriesOf(seen[0]!.params)).toEqual(expected);
    expect(entriesOf(seen[0]!.params)).toEqual(entriesOf(oracle(url)));
  });

  it("holds for any URL and any number of pending documents", async () => {
    const seen: Seen[] = [];
    const hocuspocus = holdingHocuspocus(seen);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const hostChar = fc.constantFrom(..."abcAZ019.-_~?&=#\"%:@[] ");
    const pathChar = fc.constantFrom(..."abcAZ09/?&=#\"%é<>{}|^ `");
    const host = fc.string({ unit: hostChar, minLength: 1, maxLength: 40 });
    const path = fc.string({ unit: pathChar, maxLength: 80 }).map((s) => `/${s}`);
    const absolute = fc
      .tuple(fc.constantFrom("http://", "https://"), host, path)
      .map(([scheme, h, p]) => scheme + h + p);
    const relative = path.filter((s) => !s.includes("://"));
    const url = fc.oneof(absolute, relative, fc.string({ maxLength: 60 }), fc.constant(""));
    let run = 0;

    try {
      await fc.assert(
        fc.asyncProperty(url, fc.integer({ min: 2, max: 12 }), async (u, k) => {
          run += 1;
          const request = stubRequest(u);
          const { socket, conn } = open(hocuspocus, request);
          for (let i = 0; i < k; i += 1) conn.handleMessage(frame(`p01-${run}-${i}`, WIRE_AUTH, AUTH_SUB_TOKEN));
          const mine = (): Seen[] => seen.filter((s) => s.request === request);
          try {
            if (oracleThrows(u)) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              expect(socket.closes).toEqual(Array.from({ length: k }, () => [UNAUTHORIZED_CODE, "Unauthorized"]));
              expect(mine()).toEqual([]);
              return;
            }
            await waitFor(() => mine().length === k, `${k} authentications for ${JSON.stringify(u)}`);
            const params = mine().map((s) => s.params);
            for (const p of params) expect(entriesOf(p)).toEqual(entriesOf(oracle(u)));
            if (u !== "") expect(new Set(params).size).toBe(1);
          } finally {
            conn.handleClose();
          }
        }),
        { numRuns: 300 },
      );
    } finally {
      quiet.mockRestore();
    }
  }, 60_000);

  it("keeps each connection's parse to itself whatever order frames arrive in", async () => {
    const seen: Seen[] = [];
    const hocuspocus = holdingHocuspocus(seen);
    const shapes = fc
      .array(fc.constantFrom(QUERY_URL, PLAIN_URL, "http://a?k=1/ws", "/ws?a=1"), { minLength: 2, maxLength: 5 })
      .chain((urls) =>
        fc
          .array(fc.integer({ min: 1, max: 3 }), { minLength: urls.length, maxLength: urls.length })
          .chain((counts) => {
            const pairs = urls.flatMap((_, i) => Array.from({ length: counts[i]! }, (__, j) => [i, j] as const));
            return fc.tuple(fc.constant(urls), fc.shuffledSubarray(pairs, { minLength: pairs.length }));
          }),
      );
    let run = 0;

    await fc.assert(
      fc.asyncProperty(shapes, async ([urls, order]) => {
        run += 1;
        const opened = urls.map((u) => {
          const request = stubRequest(u);
          return { request, conn: open(hocuspocus, request).conn };
        });
        for (const [i, j] of order) {
          opened[i]!.conn.handleMessage(frame(`p02-${run}-${i}-${j}`, WIRE_AUTH, AUTH_SUB_TOKEN));
        }
        const byConnection = (i: number): URLSearchParams[] =>
          seen.filter((s) => s.request === opened[i]!.request).map((s) => s.params);
        await waitFor(
          () => opened.every((_, i) => byConnection(i).length === order.filter(([c]) => c === i).length),
          "every document authenticating",
        );
        try {
          const firsts = opened.map((_, i) => byConnection(i)[0]!);
          opened.forEach((_, i) => firsts[i]!.append("owner", String(i)));
          opened.forEach((_, i) => {
            for (const p of byConnection(i)) expect(p).toBe(firsts[i]);
            expect(firsts[i]!.getAll("owner")).toEqual([String(i)]);
            expect(entriesOf(firsts[i]!).filter(([key]) => key !== "owner")).toEqual(entriesOf(oracle(urls[i]!)));
          });
          expect(new Set(firsts).size).toBe(opened.length);
        } finally {
          for (const { conn } of opened) conn.handleClose();
        }
      }),
      { numRuns: 200 },
    );
  }, 60_000);
});
