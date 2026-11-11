// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The inbound filter that runs on every reassembled message, before
 * Hocuspocus sees it (inner#1790).
 *
 * Per socket and document it remembers two facts. The handshake mark is set
 * when the client's SyncStep2 for that document passes: Updates sent before
 * it would be applied ahead of the size check `beforeSync` makes on the
 * handshake, so they are dropped. The refusal mark is set by `markRefused`
 * once the size cap refused one of the client's updates: Hocuspocus may have
 * queued the frames that followed it, and every one of them is dropped (and
 * refused by `beforeSync`, which reads the mark through `isRefused`) until the
 * client authenticates that document again, which starts a new handshake.
 *
 * A message is judged from its own bytes and the socket id only. A frame
 * that cannot be decoded passes unchanged and changes nothing, so Hocuspocus
 * answers it as it always has; nothing here closes a socket.
 */

import { MessageType } from "@hocuspocus/server";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

/** What the filter reads from a crossws peer. */
export interface FilterPeer {
  _hocuspocus?: { socketId?: string };
}

/** The marks of one document on one socket; a document with none is waiting. */
type Mark = "handshaken" | "refused";

/** Socket id → document name → mark. */
const marks = new Map<string, Map<string, Mark>>();

/** The decoded head of a message. */
interface Head {
  documentName: string;
  type: number;
  /** The sync sub-type of a Sync or SyncReply frame. */
  syncType?: number;
}

/**
 * Read the document name, the outer type and, for sync frames, the sub-type.
 * @param whole - The reassembled message.
 * @returns The head, or undefined when the bytes do not hold one.
 */
function readHead(whole: Uint8Array): Head | undefined {
  try {
    const decoder = decoding.createDecoder(whole);
    const key = decoding.readVarString(decoder);
    const type = decoding.readVarUint(decoder);
    // Hocuspocus addresses a session as `name\0sessionId` and routes it to `name`.
    const cut = key.indexOf("\0");
    const documentName = cut === -1 ? key : key.slice(0, cut);
    if (type !== MessageType.Sync && type !== MessageType.SyncReply) return { documentName, type };
    return { documentName, type, syncType: decoding.readVarUint(decoder) };
  } catch {
    // lib0 throws on a read past the end; such a frame is not ours to judge.
    return undefined;
  }
}

/**
 * Decide whether a reassembled message reaches Hocuspocus.
 * @param peer - The socket the message came from.
 * @param whole - The reassembled message.
 * @returns The message unchanged, or undefined to drop it.
 */
export function filter(peer: FilterPeer, whole: Uint8Array): Uint8Array | undefined {
  const socketId = peer._hocuspocus?.socketId;
  if (socketId === undefined) return whole;
  const head = readHead(whole);
  if (head === undefined) return whole;
  const docs = marks.get(socketId);
  if (head.type === MessageType.Auth) {
    docs?.delete(head.documentName);
    return whole;
  }
  const mark = docs?.get(head.documentName);
  if (mark === "refused") return undefined;
  if (head.syncType === syncProtocol.messageYjsSyncStep2) {
    if (docs === undefined) marks.set(socketId, new Map([[head.documentName, "handshaken"]]));
    else docs.set(head.documentName, "handshaken");
    return whole;
  }
  if (head.syncType === syncProtocol.messageYjsUpdate && mark !== "handshaken") return undefined;
  return whole;
}

/**
 * Drop every later message of a document on a socket until it authenticates
 * that document again.
 * @param socketId - The Hocuspocus socket id.
 * @param documentName - The document the size cap refused an update of.
 */
export function markRefused(socketId: string, documentName: string): void {
  const docs = marks.get(socketId);
  if (docs === undefined) marks.set(socketId, new Map([[documentName, "refused"]]));
  else docs.set(documentName, "refused");
}

/**
 * Whether a document on a socket carries the refusal mark, so `beforeSync`
 * refuses what Hocuspocus had already queued behind the refused message.
 * @param socketId - The Hocuspocus socket id.
 * @param documentName - The document.
 * @returns True until the socket authenticates that document again.
 */
export function isRefused(socketId: string, documentName: string): boolean {
  return marks.get(socketId)?.get(documentName) === "refused";
}

/**
 * Forget a closed socket's marks.
 * @param peer - The socket crossws reports closed or failed.
 */
export function forgetSocket(peer: FilterPeer): void {
  const socketId = peer._hocuspocus?.socketId;
  if (socketId !== undefined) marks.delete(socketId);
}
