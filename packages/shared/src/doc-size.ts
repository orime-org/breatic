// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";

/**
 * The bytes counted for one split endpoint or one delete range past the
 * server's clock of its client: either can add up to two ids (a client id
 * takes up to 5 varuint bytes, a clock up to 8), an info byte and a length
 * field to the encoded document. Collab charges an update with it for each
 * split endpoint and beyond-clock range that `updateShape`
 * (`@shared/update-shape.ts`) counts.
 */
export const DOC_SIZE_EVENT_BYTES = 32;

const bytes = z.number().int().nonnegative();

/**
 * The size of one Space document as collab counts it, pushed over the
 * document's stateless channel. `seq` numbers the document's pushes on one
 * collab instance; `limit` 0 means the deployment sets no limit; `bytes ≥
 * ceiling` means the document is past its hard ceiling.
 */
export const DocSizeStatusSchema = z.object({
  type: z.literal("doc:size"),
  seq: bytes,
  bytes,
  limit: bytes,
  ceiling: bytes,
  phase: z.enum(["normal", "warning", "full"]),
});

/** One parsed `doc:size` push. */
export type DocSizeStatus = z.infer<typeof DocSizeStatusSchema>;

/**
 * The client's acknowledgement of a `doc:size` push, sent as soon as it is
 * handled: collab judges the client's later messages by the phase it names.
 */
export const DocSizeSeenSchema = z.object({
  type: z.literal("doc:size-seen"),
  seq: bytes,
});

/** One parsed `doc:size-seen` acknowledgement. */
export type DocSizeSeen = z.infer<typeof DocSizeSeenSchema>;

/**
 * The WebSocket parameter (value `1`) a client sets when it acknowledges
 * `doc:size` pushes and handles the size-limit close.
 */
export const DOC_SIZE_ACK_PARAM = "size_ack";
