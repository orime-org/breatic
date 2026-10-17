// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The per-socket limits the collab server runs with, derived from a project's
 * Space cap.
 *
 * The library closes a WHOLE socket — close code 4205, every Space on it goes
 * blank — in four places (hocuspocus-server.esm.js: 819, 886 twice, 958). All
 * four are calibrated for one document per socket. Ours carries a project: the
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
 * The queued-frame count only has to bound how many objects a socket can
 * pile up; the queued-byte ceiling, left at the library's value, is what
 * bounds memory. A client back from being offline replays one frame per edit
 * it made, so no document count can size the frame count: it is set so that a
 * real client's frames always meet the byte ceiling first.
 *
 *   pending documents    default 100    set to a full project's documents
 *   queued frame count   default 1000   byte ceiling / shortest project frame
 *   queued frame bytes   default 5 MB   left alone
 *   idle timeout         default 60 s   client resends awareness every 15 s, left alone
 */
import * as encoding from "lib0/encoding";
import { defaultConfiguration } from "@hocuspocus/server";
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

/** The per-socket limits the Hocuspocus server is configured with. */
export interface SocketCeilings {
  /** Documents that may await authentication on one socket at once. */
  maxPendingDocuments: number;
  /** Frames those pending documents may hold in the queue between them. */
  maxUnauthenticatedQueueMessages: number;
}

/** The limits to pass to the Hocuspocus server. */
export const SOCKET_CEILINGS: SocketCeilings = {
  maxPendingDocuments: DOCUMENTS_PER_SOCKET,
  maxUnauthenticatedQueueMessages: Math.ceil(
    defaultConfiguration.maxUnauthenticatedQueueSize / shortestProjectFrameBytes(),
  ),
};
