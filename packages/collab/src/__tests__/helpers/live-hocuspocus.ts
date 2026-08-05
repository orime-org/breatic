// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A real Hocuspocus instance with fake sockets plugged into it.
 *
 * The fake `transact` the other collab tests use (`async (fn) => fn(doc)`)
 * neither broadcasts nor persists and never rejects, so two whole classes of
 * claim are invisible to it: "did this change actually go out on the wire, and
 * in what order" and "what happens when the store fails after it went out".
 * Both are decided by the framework, not by us, so the only way to measure
 * them is to run the framework.
 *
 * What this gives a test:
 *
 *   - `createLiveServer` — a `Hocuspocus` with no network listener. Documents
 *     load, direct connections work, hooks fire.
 *   - `connectLiveClient` — a client attached through the real
 *     `handleConnection` path (`ClientConnection` → `Connection` →
 *     `MessageReceiver`), so read-only is applied exactly where production
 *     applies it. Everything the server sends this client is decoded and
 *     recorded, which makes the broadcast an observable event with a position.
 *
 * Measured facts this encodes, from the 2026-08-01 probe and the bundled
 * source:
 *
 *   - `Document.handleUpdate` is bound to the Y.Doc "update" event and sends to
 *     every connection synchronously, so a recorded Sync/Update frame marks the
 *     exact moment of the broadcast.
 *   - One failed store poisons the document: later transacts on it reject too.
 *     Give every case its own document name.
 *   - A failing persistence hook also produces an unhandled rejection separate
 *     from the one `transact` hands back — see `captureUnhandledRejections`.
 *   - `server.destroy()` hangs; do not call it. Close the sockets instead
 *     (`LiveClient.close`), which is what clears the per-connection ping timer.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import { Hocuspocus } from "@hocuspocus/server";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/** Hocuspocus outer message types, as they appear on the wire. */
export const WIRE = {
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
  syncReply: 4,
  stateless: 5,
  broadcastStateless: 6,
  close: 7,
  syncStatus: 8,
} as const;

/** y-protocols sync sub-types, the second integer of a sync frame. */
export const SYNC = { step1: 0, step2: 1, update: 2 } as const;

/** Sub-types of an `auth` frame. */
const AUTH_SUB = { token: 0, permissionDenied: 1, authenticated: 2 } as const;

/** Placeholder token the real frontend sends; the cookie carries the session. */
export const COOKIE_AUTH_TOKEN = "__cookie_auth__";

/** One decoded server → client message. */
export interface ServerFrame {
  /** Document the frame is addressed to. */
  docName: string;
  /** Outer message type — compare against {@link WIRE}. */
  type: number;
  /** Second integer of a sync frame — compare against {@link SYNC}. */
  syncSubType?: number;
  /** Yjs payload of an `update` / `step2` frame, so a test can apply it. */
  update?: Uint8Array;
  /** Payload of a stateless frame. */
  stateless?: string;
  /** Sub-type of an auth frame — compare against the auth cases. */
  authSubType?: number;
  /** `readonly` / `read-write` on success, or the denial reason. */
  authDetail?: string;
  /** Whether the server says it applied the update, for a sync-status frame. */
  syncStatusOk?: boolean;
}

/**
 * Decode one server → client frame far enough to assert on it.
 * @param bytes - The raw frame as the server handed it to the socket.
 * @returns The decoded frame.
 */
export function decodeServerFrame(bytes: Uint8Array): ServerFrame {
  const decoder = decoding.createDecoder(bytes);
  const docName = decoding.readVarString(decoder);
  const type = decoding.readVarUint(decoder);
  const frame: ServerFrame = { docName, type };
  if (type === WIRE.sync || type === WIRE.syncReply) {
    const syncSubType = decoding.readVarUint(decoder);
    frame.syncSubType = syncSubType;
    if (syncSubType === SYNC.update || syncSubType === SYNC.step2) {
      frame.update = decoding.readVarUint8Array(decoder);
    }
  } else if (type === WIRE.stateless) {
    frame.stateless = decoding.readVarString(decoder);
  } else if (type === WIRE.syncStatus) {
    frame.syncStatusOk = decoding.readVarUint(decoder) === 1;
  } else if (type === WIRE.auth) {
    const sub = decoding.readVarUint(decoder);
    frame.authSubType = sub;
    if (sub !== AUTH_SUB.token) {
      frame.authDetail = decoding.readVarString(decoder);
    }
  }
  return frame;
}

/**
 * Start a client → server frame with the document-name prefix multiplexing
 * puts in front of every real message.
 * @param docName - Document the frame is addressed to.
 * @param write - Writes the rest of the frame.
 * @returns The encoded frame.
 */
function buildFrame(
  docName: string,
  write: (encoder: encoding.Encoder) => void,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, docName);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

/**
 * The authentication frame a client sends first on every document.
 * @param docName - Document being opened.
 * @param token - Opaque token; the session travels in the cookie instead.
 * @returns The encoded frame.
 */
export function authFrame(docName: string, token: string): Uint8Array {
  return buildFrame(docName, (encoder) => {
    encoding.writeVarUint(encoder, WIRE.auth);
    encoding.writeVarUint(encoder, AUTH_SUB.token);
    encoding.writeVarString(encoder, token);
  });
}

/**
 * A frame carrying a Yjs update, in whichever of the shapes that reach the
 * same apply branch the caller wants to try.
 * @param docName - Document being written.
 * @param outerType - `WIRE.sync` or `WIRE.syncReply`.
 * @param syncSubType - `SYNC.update` or `SYNC.step2`.
 * @param update - The Yjs update bytes.
 * @returns The encoded frame.
 */
export function syncFrame(
  docName: string,
  outerType: number,
  syncSubType: number,
  update: Uint8Array,
): Uint8Array {
  return buildFrame(docName, (encoder) => {
    encoding.writeVarUint(encoder, outerType);
    encoding.writeVarUint(encoder, syncSubType);
    encoding.writeVarUint8Array(encoder, update);
  });
}

/**
 * A frame on the stateless channel — the one the Space / tab RPCs ride.
 * @param docName - Document the RPC is addressed to.
 * @param payload - JSON string body.
 * @returns The encoded frame.
 */
export function statelessFrame(docName: string, payload: string): Uint8Array {
  return buildFrame(docName, (encoder) => {
    encoding.writeVarUint(encoder, WIRE.stateless);
    encoding.writeVarString(encoder, payload);
  });
}

/**
 * A frame carrying an awareness (presence / cursor) update.
 * @param docName - Document the presence belongs to.
 * @param update - Encoded awareness update.
 * @returns The encoded frame.
 */
export function awarenessFrame(
  docName: string,
  update: Uint8Array,
): Uint8Array {
  return buildFrame(docName, (encoder) => {
    encoding.writeVarUint(encoder, WIRE.awareness);
    encoding.writeVarUint8Array(encoder, update);
  });
}

/**
 * The subset of the `ws` surface Hocuspocus touches, backed by an array
 * instead of a socket.
 */
class FakeWebSocket extends EventEmitter {
  /** Hocuspocus sets this on every connection it builds. */
  public binaryType = "nodebuffer";

  /** 1 = Open, matching `WsReadyStates`. */
  public readyState = 1;

  /** Everything the server has sent this client, oldest first. */
  public readonly sent: Uint8Array[] = [];

  /**
   * Record a server → client message.
   * @param data - Raw frame.
   * @param callback - Hocuspocus passes an error-first callback.
   * @returns Nothing.
   */
  public send(data: Uint8Array, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  /**
   * Close from the client side, which is what clears the ping timer.
   * @returns Nothing.
   */
  public close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }

  /**
   * Keep-alive; nothing to do without a real socket.
   * @returns Nothing.
   */
  public ping(): void {}

  /**
   * Hard close; same as {@link close} here.
   * @returns Nothing.
   */
  public terminate(): void {
    this.close();
  }
}

/** A client attached to a live server through the real connection path. */
export interface LiveClient {
  /** Every server → client frame so far, decoded, oldest first. */
  frames(): ServerFrame[];
  /** Send one client → server frame. */
  send(bytes: Uint8Array): void;
  /** Close the socket, clearing the connection's ping timer. */
  close(): void;
  /** Whether the handshake ended in `Authenticated` rather than a denial. */
  authenticated: boolean;
  /** `readonly` or `read-write`, exactly as the framework reported it. */
  authorizedScope: string | undefined;
}

/**
 * Let queued microtasks and timers run until `predicate` holds.
 * @param predicate - Condition to wait for.
 * @param label - Included in the timeout message so a hang says what it wanted.
 * @param timeoutMs - How long to keep trying.
 * @returns Nothing.
 * @throws {Error} When the predicate has not held by `timeoutMs`.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Build a Hocuspocus instance with no network listener.
 *
 * `debounce: 0` makes every store attempt run in the same turn rather than
 * behind a timer — a test that ends with a pending store timer both leaks it
 * into the next file (this package runs single-fork) and hides the failure it
 * was arming.
 * @param configuration - Hooks and extensions for this instance.
 * @returns The instance. Do not call `destroy()` on it; it hangs.
 */
export function createLiveServer(
  configuration: Record<string, unknown> = {},
): Hocuspocus {
  return new Hocuspocus({
    quiet: true,
    debounce: 0,
    maxDebounce: 0,
    // Long enough that the keep-alive check never fires mid-test; the timer is
    // cleared by closing the socket.
    timeout: 60_000,
    ...configuration,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/**
 * Attach a client to a live server the way a browser does: open the socket,
 * send the auth frame, wait for the framework's answer.
 * @param hocuspocus - The live server.
 * @param docName - Document to open.
 * @param options - Request shaping.
 * @param options.cookie - Value of the `Cookie:` header on the upgrade request.
 * @returns The connected (or refused) client.
 * @throws {Error} When the server never answers the handshake.
 */
export async function connectLiveClient(
  hocuspocus: Hocuspocus,
  docName: string,
  options: { cookie?: string } = {},
): Promise<LiveClient> {
  const socket = new FakeWebSocket();
  const request = {
    headers: { cookie: options.cookie ?? "" },
    url: `/${docName}`,
  } as unknown as IncomingMessage;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hocuspocus.handleConnection(socket as any, request);
  socket.emit("message", authFrame(docName, COOKIE_AUTH_TOKEN));

  /**
   * Decode everything the server has sent so far.
   * @returns The decoded frames, oldest first.
   */
  const frames = (): ServerFrame[] => socket.sent.map(decodeServerFrame);

  await waitFor(
    () => frames().some((f) => f.type === WIRE.auth),
    `handshake answer for ${docName}`,
  );
  const authFrameReceived = frames().find((f) => f.type === WIRE.auth);
  const authenticated =
    authFrameReceived?.authSubType === AUTH_SUB.authenticated;
  if (authenticated) {
    // `setUpNewConnection` runs after the Authenticated frame is sent; the
    // Connection only exists once it has.
    await waitFor(
      () => (hocuspocus.documents.get(docName)?.getConnectionsCount() ?? 0) > 0,
      `connection registered on ${docName}`,
    );
  }

  return {
    frames,
    send: (bytes: Uint8Array): void => {
      socket.emit("message", bytes);
    },
    close: (): void => {
      socket.close();
    },
    authenticated,
    authorizedScope: authFrameReceived?.authDetail,
  };
}

/** Records unhandled rejections instead of letting them fail the run. */
export interface RejectionTrap {
  /** Messages of the rejections that escaped while the trap was installed. */
  escaped: string[];
  /** Put the previous listeners back. */
  restore(): void;
}

/**
 * Take over `unhandledRejection` for the duration of a test.
 *
 * A failing persistence hook can produce a second, unowned rejection alongside
 * the one `transact` returns: `storeDocumentHooks` schedules `unloadDocument`
 * from a `setTimeout` and nothing awaits it, so on a poisoned document it
 * rejects with no one listening. Under Node's default that ends the process;
 * under vitest it fails the file, for something no test is about.
 *
 * It only fires when the document has no connections left — `unloadDocument`
 * returns early otherwise — so a test that keeps a client attached will see an
 * empty `escaped`. Install it anyway: the cost is a listener, and the failure
 * it prevents takes the whole file with it.
 * @returns The trap. Call `restore()` in a `finally` or `afterAll`.
 */
export function captureUnhandledRejections(): RejectionTrap {
  const previous = process.listeners("unhandledRejection");
  const escaped: string[] = [];
  process.removeAllListeners("unhandledRejection");
  /**
   * Record one escaped rejection.
   * @param reason - Whatever was rejected with.
   * @returns Nothing.
   */
  const listener = (reason: unknown): void => {
    escaped.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", listener);
  return {
    escaped,
    restore: (): void => {
      process.removeListener("unhandledRejection", listener);
      for (const l of previous) {
        process.on("unhandledRejection", l);
      }
    },
  };
}
