// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reassembly of collab messages larger than one WebSocket frame (inner#1585).
 *
 * The browser sends such a message as a text declaration
 * `{"type":"chunked","bytes":N}` followed by binary chunks
 * (`@breatic/shared` `sendInChunks`). Each connection is idle, assembling or
 * closed; idle is the absence of a record. Memory is bounded three ways: a
 * per-connection cap, a share per user of the same size, and a process
 * budget, all reserved when the declaration is accepted; a stall between two
 * chunks is bounded by an idle timer. Every refusal closes the connection and
 * leaves one log line.
 *
 * ws keeps delivering frames after we close a connection until the close
 * handshake ends, and the rest of a refused message is already on its way,
 * so a closed connection drops everything until crossws reports the close.
 */

import { COLLAB_FRAME_MAX_BYTES, collabChunkHeaderSchema } from "@breatic/shared";
import { createLogger } from "@breatic/core";

const logger = createLogger("frame-assembler");

/** ws's fixed message for a frame over `maxPayload`; crossws keeps only the text. */
const PAYLOAD_TOO_LARGE = "Max payload size exceeded";

/** Our close codes and the reasons the browser receives with them. */
const CLOSE = {
  tooLarge: { code: 1009, reason: "message too large" },
  budget: { code: 1013, reason: "reassembly budget exhausted" },
  malformed: { code: 1002, reason: "malformed frame" },
  idle: { code: 1008, reason: "reassembly idle timeout" },
} as const;

/** What the reassembler reads from a crossws peer. */
interface FramePeer {
  readonly remoteAddress?: string;
  _hocuspocus?: { socketId?: string };
  close(code?: number, reason?: string): void;
}

/** What the reassembler reads from a crossws message; text frames carry a string. */
interface FrameMessage {
  rawData: unknown;
  uint8Array(): Uint8Array;
  text(): string;
}

/** Whose share a reservation counts against: the user, or the connection when no user is known. */
type ShareKey = string | object;

/** A connection with an accepted declaration. */
interface Assembling {
  kind: "assembling";
  key: ShareKey;
  bytes: number;
  received: number;
  chunks: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Per-connection record; an idle connection has none. */
type PeerState = Assembling | { kind: "closed" };

/** Limits and the identity lookup the reassembler is built with. */
export interface FrameAssemblerOptions {
  /** The largest message one connection, and one user, may reassemble. */
  maxMessageBytes: number;
  /** What all connections together may hold while reassembling. */
  budgetBytes: number;
  /** The longest wait between two chunks. */
  idleTimeoutMs: number;
  /** The session's user of a connection, when it is known. */
  userOf(peer: object): string | undefined;
}

/** The crossws hooks and the counters they keep. */
export interface FrameAssembler {
  /** The bytes to hand to Hocuspocus for one frame, or undefined for none. */
  receiveFrame(peer: object, message: object): Uint8Array | undefined;
  /** crossws reported the connection closed. */
  onPeerClose(peer: object, event: unknown): void;
  /** ws reported an error; it closes the connection itself. */
  onPeerError(peer: object, error: unknown): void;
  /** Bytes reserved by every connection now reassembling. */
  inUseBytes(): number;
  /** Bytes reserved per user (or per connection without a user). */
  userInUse(): ReadonlyMap<ShareKey, number>;
}

/**
 * Build the reassembler for one collab process.
 * @param options - Limits and the identity lookup.
 * @returns The crossws hooks and counters.
 */
export function createFrameAssembler(options: FrameAssemblerOptions): FrameAssembler {
  const { maxMessageBytes, budgetBytes, idleTimeoutMs, userOf } = options;
  const states = new WeakMap<object, PeerState>();
  const shares = new Map<ShareKey, number>();
  let inUse = 0;

  /**
   * The identity fields every log line carries.
   * @param peer - The connection.
   * @returns Socket id, user and address, null when unknown.
   */
  function identity(peer: FramePeer): Record<string, unknown> {
    return {
      socketId: peer._hocuspocus?.socketId ?? null,
      userId: userOf(peer) ?? null,
      remoteAddress: peer.remoteAddress ?? null,
    };
  }

  /**
   * Return a connection's reservation, stop its timer and drop its chunks;
   * the one clean-up step every exit from assembling takes.
   * @param peer - The connection.
   */
  function release(peer: object): void {
    const state = states.get(peer);
    if (state?.kind !== "assembling") return;
    clearTimeout(state.timer);
    inUse -= state.bytes;
    const left = (shares.get(state.key) ?? 0) - state.bytes;
    if (left === 0) shares.delete(state.key);
    else shares.set(state.key, left);
    states.delete(peer);
  }

  /**
   * Close a connection we refuse, after logging why.
   * @param peer - The connection.
   * @param close - Code and reason.
   * @param event - Log event name.
   * @param fields - Byte fields for the log line.
   */
  function reject(peer: FramePeer, close: { code: number; reason: string }, event: string, fields: Record<string, unknown>): void {
    logger.warn({ ctx: { ...identity(peer), ...fields } }, event);
    release(peer);
    states.set(peer, { kind: "closed" });
    peer.close(close.code, close.reason);
  }

  /**
   * Arm or re-arm the idle timer of an assembling connection.
   * @param peer - The connection.
   * @param state - Its record.
   */
  function arm(peer: FramePeer, state: Assembling): void {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      reject(peer, CLOSE.idle, "collab_reassembly_idle_timeout", { receivedBytes: state.received, bytes: state.bytes });
    }, idleTimeoutMs);
  }

  /**
   * Handle a text frame on an idle connection: it must be a declaration.
   * @param peer - The connection.
   * @param text - The frame.
   */
  function declare(peer: FramePeer, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const header = collabChunkHeaderSchema.safeParse(parsed);
    if (!header.success) {
      reject(peer, CLOSE.malformed, "collab_frame_malformed", {
        reason: "bad_header", frameBytes: Buffer.byteLength(text), bytes: null, receivedBytes: 0,
      });
      return;
    }
    const { bytes } = header.data;
    if (bytes > maxMessageBytes) {
      reject(peer, CLOSE.tooLarge, "collab_message_too_large", { source: "declared", bytes, limit: maxMessageBytes });
      return;
    }
    const key = userOf(peer) ?? peer;
    const held = shares.get(key) ?? 0;
    const overShare = held + bytes > maxMessageBytes;
    if (overShare || inUse + bytes > budgetBytes) {
      reject(peer, CLOSE.budget, "collab_reassembly_budget_exhausted", {
        scope: overShare ? "user" : "process", bytes, userInUseBytes: held, inUseBytes: inUse, budgetBytes,
      });
      return;
    }
    inUse += bytes;
    shares.set(key, held + bytes);
    const state: Assembling = { kind: "assembling", key, bytes, received: 0, chunks: [], timer: undefined };
    states.set(peer, state);
    arm(peer, state);
  }

  /**
   * Take one binary chunk of an assembling connection.
   * @param peer - The connection.
   * @param state - Its record.
   * @param chunk - The chunk.
   * @returns The whole message when this chunk completes it.
   */
  function take(peer: FramePeer, state: Assembling, chunk: Uint8Array): Uint8Array | undefined {
    const after = state.received + chunk.byteLength;
    if (after > state.bytes) {
      if (after > maxMessageBytes) {
        reject(peer, CLOSE.tooLarge, "collab_message_too_large", { source: "received", bytes: after, limit: maxMessageBytes });
      } else {
        reject(peer, CLOSE.malformed, "collab_frame_malformed", {
          reason: "overflow", frameBytes: chunk.byteLength, bytes: state.bytes, receivedBytes: state.received,
        });
      }
      return undefined;
    }
    if (after < state.bytes && chunk.byteLength < COLLAB_FRAME_MAX_BYTES) {
      reject(peer, CLOSE.malformed, "collab_frame_malformed", {
        reason: "short_chunk", frameBytes: chunk.byteLength, bytes: state.bytes, receivedBytes: state.received,
      });
      return undefined;
    }
    state.chunks.push(chunk);
    state.received = after;
    if (after < state.bytes) {
      arm(peer, state);
      return undefined;
    }
    const whole = new Uint8Array(after);
    let offset = 0;
    for (const part of state.chunks) {
      whole.set(part, offset);
      offset += part.byteLength;
    }
    release(peer);
    return whole;
  }

  return {
    receiveFrame(peer: object, message: object): Uint8Array | undefined {
      const p = peer as FramePeer;
      const m = message as FrameMessage;
      const state = states.get(peer);
      if (state?.kind === "closed") return undefined;
      const isText = typeof m.rawData === "string";
      if (state === undefined) {
        if (!isText) return m.uint8Array();
        declare(p, m.text());
        return undefined;
      }
      if (isText) {
        reject(p, CLOSE.malformed, "collab_frame_malformed", {
          reason: "text_during_reassembly", frameBytes: Buffer.byteLength(m.text()), bytes: state.bytes, receivedBytes: state.received,
        });
        return undefined;
      }
      return take(p, state, m.uint8Array());
    },

    onPeerClose(peer: object): void {
      release(peer);
      states.delete(peer);
    },

    onPeerError(peer: object, error: unknown): void {
      const p = peer as FramePeer;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(PAYLOAD_TOO_LARGE)) {
        logger.warn({ err: error, ctx: { ...identity(p), limit: COLLAB_FRAME_MAX_BYTES } }, "collab_frame_too_large");
      } else {
        logger.error({ err: error, ctx: identity(p) }, "collab_socket_error");
      }
      if (states.get(peer)?.kind === "closed") return;
      release(peer);
      states.set(peer, { kind: "closed" });
    },

    inUseBytes: (): number => inUse,
    userInUse: (): ReadonlyMap<ShareKey, number> => shares,
  };
}
