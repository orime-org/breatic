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
 * the frames a real client sends to see it. Deriving both from the Space cap
 * is what stops them drifting apart again.
 *
 * Measured against sockets carrying real client frames:
 *
 *   pending documents    default 100    fires first; set to a full project
 *   queued frame count   default 1000   fires at ~500 documents; never set below it
 *   queued frame bytes   default 5 MB   ~390 KB for 1000 documents, so left alone
 *   idle timeout         default 60 s   client resends awareness every 15 s, left alone
 *
 * The byte ceiling is deliberately NOT derived. It is the one that actually
 * bounds memory, and leaving it at the library's own value keeps a real guard
 * in place behind the two generous ones above; `socket-ceilings.test.ts` pins
 * that the derived frame count can never outgrow it.
 */
import { MAX_SPACES_PER_PROJECT } from "@breatic/shared";

/**
 * Frames one pending document puts in the queue before its authentication
 * settles. Measured against the v4 provider: it sends the auth frame (which
 * is not queued, it is the trigger), then sync-step-one, then an awareness
 * update — because every provider builds its own Awareness whose local state
 * starts non-null.
 */
export const QUEUED_FRAMES_PER_DOCUMENT = 2;

/**
 * Multiplier on the measured frame count. A client reconnecting mid-edit
 * replays buffered work as well as opening documents, and the cost of being
 * wrong is asymmetric: too low closes a real member's socket, too high spends
 * queue entries whose memory the byte ceiling already bounds.
 */
const QUEUE_HEADROOM = 2;

/**
 * The library's own queued-frame ceiling. A full project needs fewer frames
 * than this, so the derived figure never goes below it: the spare entries are
 * what a reconnecting client's offline backlog lands in.
 */
const LIBRARY_QUEUE_FRAME_CEILING = 1000;

/** The per-socket limits the Hocuspocus server is configured with. */
export interface SocketCeilings {
  /** Documents that may await authentication on one socket at once. */
  maxPendingDocuments: number;
  /** Frames those pending documents may hold in the queue between them. */
  maxUnauthenticatedQueueMessages: number;
}

/**
 * Derive the per-socket ceilings from the documents one socket carries at
 * most: a full project's Spaces plus its meta doc.
 * @returns The limits to pass to the Hocuspocus server.
 */
export function socketCeilings(): SocketCeilings {
  const documentsPerSocket = MAX_SPACES_PER_PROJECT + 1;
  return {
    maxPendingDocuments: documentsPerSocket,
    maxUnauthenticatedQueueMessages: Math.max(
      LIBRARY_QUEUE_FRAME_CEILING,
      documentsPerSocket * QUEUED_FRAMES_PER_DOCUMENT * QUEUE_HEADROOM,
    ),
  };
}
