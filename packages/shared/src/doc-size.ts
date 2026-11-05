// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";

/**
 * The most bytes one size-changing event inside a Yjs update can add to the
 * encoded document: a split, a new delete-set entry, a cascaded child or a
 * format item removed by cleanup. Each carries at most two ids (a client id
 * takes up to 5 varuint bytes, a clock up to 8), plus an info byte and a
 * length field. Collab bounds growth with it and web derives
 * {@link SPACE_DELETE_MIN_BYTES} from it, so both ends read this one value.
 */
export const DOC_SIZE_EVENT_BYTES = 32;

/**
 * How many UTF-8 bytes of text one ProseMirror delete must remove on a
 * document above its hard ceiling, unless it removes a whole node: a smaller
 * delete splits items and grows the encoding by up to two events.
 */
export const SPACE_DELETE_MIN_BYTES = 2 * DOC_SIZE_EVENT_BYTES + 16;

const bytes = z.number().int().nonnegative();

/**
 * The size of one Space document as collab measured it, pushed over the
 * document's stateless channel. `limit` 0 means the deployment sets no limit.
 */
export const DocSizeStatusSchema = z.object({
  type: z.literal("doc:size"),
  bytes,
  limit: bytes,
  ceiling: bytes,
  room: bytes,
  overwriteRoom: bytes,
  phase: z.enum(["normal", "warning", "full"]),
});

/** One parsed `doc:size` push. */
export type DocSizeStatus = z.infer<typeof DocSizeStatusSchema>;
