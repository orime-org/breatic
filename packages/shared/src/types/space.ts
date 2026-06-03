// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Space — Yjs-resident sub-region of a project (v10 §5.3.1).
 *
 * Spaces have NO PG table. Their entries live in the project's Yjs
 * `meta` doc (`project-{pid}/meta`) under `Y.Map('spaces')`. The
 * `yjs_documents` table only persists Yjs binary blobs — both for
 * the meta doc itself and for each Space's content doc (e.g.
 * `project-{pid}/canvas-{spaceId}`).
 *
 * `tasks.space_id` (PG) references a Space by id but does NOT have
 * an FK constraint — Spaces are not in PG, so there is no FK target.
 * It's a plain UUID string for round-tripping through the BullMQ
 * payload + worker handler.
 */

/**
 * Space kinds.
 *
 * Canvas is the only kind implemented in V1. Document and Timeline
 * are reserved (spec §1.2) — server-side schemas accept them so the
 * route surface is forward-compatible, but the route layer rejects
 * non-canvas creation in V1.
 */
import { z } from "zod";

/**
 * Zod schema mirror of {@link SpaceType}. Used by cross-process RPC
 * payloads (e.g. `space-rpc.ts`) for runtime validation.
 */
export const SpaceTypeSchema = z.enum(["canvas", "document", "timeline"]);

export type SpaceType = z.infer<typeof SpaceTypeSchema>;

/**
 * One entry in `meta.spaces` (the canonical Space record).
 *
 * Persisted exclusively in Yjs; surfaced here as a TypeScript type
 * for cross-process payloads (Redis control-plane events) and
 * frontend hooks that read the meta Y.Map.
 */
export interface Space {
  id: string;
  type: SpaceType;
  name: string;
  /** Display order in the tab bar (smaller = leftmost). */
  order: number;
  /**
   * Tab lock — UX guard against accidental deletion. NOT a security
   * mechanism (writes are gated by `requireRole` / Hocuspocus
   * readOnly, not by this flag).
   */
  locked: boolean;
  /** Epoch ms. */
  createdAt: number;
}
