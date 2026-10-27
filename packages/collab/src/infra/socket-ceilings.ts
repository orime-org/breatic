// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The per-socket limits the collab server runs with, derived from a project's
 * Space cap.
 *
 * `@hocuspocus/server` closes a WHOLE socket — every Space on it goes blank —
 * at four limits (close code 4205 for the three queue limits, 4408 for the idle
 * timeout), all calibrated for one document per socket. Ours carries a project: the
 * meta doc plus one per open Space tab, and a member can open every Space the
 * project has. A project holds at most `MAX_SPACES_PER_PROJECT` live Spaces,
 * so one socket carries at most that many plus the meta doc.
 *
 * They are derived here rather than listed in the config file because raising
 * one alone is not a fix: the next one down fires with the same close code and
 * the same symptom, so a socket that survived the first wall reconnects
 * straight into the second. That is not hypothetical — it is what happened
 * when only `maxPendingDocuments` was raised, and it took a live test sending
 * the frames a real client sends to see it. Deriving both
 * together here is what stops them drifting apart again.
 *
 * Every queued frame keeps its bytes plus some of its own (the copy
 * `patches/@hocuspocus__server@4.6.0.patch` makes and its slot in the queue):
 * up to 270 bytes for frames of 64 bytes or less, which V8 keeps on its heap,
 * and about 385 for longer ones, whose bytes sit outside it. So the byte
 * ceiling alone does not bound what the queue holds: frames of the shortest
 * name would hold several times their payload. The frame count is therefore
 * set so that the shortest frames reach it at the byte ceiling's worth of
 * memory. With both in force one unauthenticated socket's queue peaks at
 * frames of about 320 bytes, where the two ceilings meet: about 15–18 MB
 * resident per socket, measured (RSS varies with the machine's state). A client back from being offline replays
 * one frame per edit and can meet either ceiling first. Each pending document
 * also holds a hook payload outside both ceilings; the same patch parses the
 * request URL once per connection, so that payload stays small whatever URL or
 * Host the client sends (inner#1589).
 *
 *   pending documents    default 100    set to a full project's documents
 *   queued frame count   default 1000   byte ceiling / (shortest frame + its overhead)
 *   queued frame bytes   default 5 MB   left alone
 *   idle timeout         default 60 s   client resends awareness every 15 s, left alone
 */
import * as encoding from "lib0/encoding";
import { defaultConfiguration, type Configuration } from "@hocuspocus/server";
import { MAX_SPACES_PER_PROJECT, projectMetaDocName } from "@breatic/shared";

/** Documents one socket carries at most: a full project's Spaces plus its meta doc. */
export const DOCUMENTS_PER_SOCKET = MAX_SPACES_PER_PROJECT + 1;

/**
 * Bytes of the shortest frame a client sends for a project document: the
 * meta doc's name followed by a message type. Every real frame is at least
 * this long, since every one is addressed to a document by name.
 * @returns The encoded length.
 */
function shortestProjectFrameBytes(): number {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, projectMetaDocName("00000000-0000-0000-0000-000000000000"));
  encoding.writeVarUint(encoder, 0);
  return encoding.length(encoder);
}

/**
 * Bytes the shortest queued frame keeps on top of its payload: the most
 * measured with the patched `@hocuspocus/server` 4.6.0 on Node 24 (inner#1140)
 * for frames of 64 bytes or less, which V8 keeps on its heap. Measure again
 * when either changes.
 */
const QUEUED_FRAME_OVERHEAD_BYTES = 270;

/** The limits to pass to the Hocuspocus server. */
export const SOCKET_CEILINGS = {
  maxPendingDocuments: DOCUMENTS_PER_SOCKET,
  maxUnauthenticatedQueueMessages: Math.ceil(
    defaultConfiguration.maxUnauthenticatedQueueSize /
      (shortestProjectFrameBytes() + QUEUED_FRAME_OVERHEAD_BYTES),
  ),
} satisfies Partial<Configuration>;
