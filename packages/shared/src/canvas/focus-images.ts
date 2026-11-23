// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a focus image is (#1782, #1580): the one rule the page's pool read, the reference-pool cap, the upload ticket
 * and collab's append all apply. A node's `focusImages` is collaborative Yjs data, so every reader narrows it through
 * {@link validFocusImages}; two readers disagreeing is how a malformed entry became an invisible but counted pool slot.
 *
 * A crop's upload names the image it will become (`focusImageTicketSchema`); once its bytes are registered, the server
 * hands the image with its registered address to collab ({@link FocusImageUploadEvent}), which adds it to the node's
 * pool. The page never writes the result.
 */

import { z } from "zod";
import type { FocusImage, FocusUpload } from "@shared/types/canvas-node.js";

/** Longest id kept. */
export const MAX_FOCUS_ID = 128;
/** Longest address kept, the asset ledger's bound. */
export const MAX_FOCUS_URL = 2048;
/** Largest crop side, in natural pixels. */
export const MAX_FOCUS_DIMENSION = 100_000;
/** Longest source-name snapshot; the crop pipeline clamps to it before uploading. */
export const MAX_FOCUS_NAME = 300;
/**
 * Most entries a pool keeps: above the configurable reference-pool cap, and a hard ceiling against a megabyte array
 * of entries that are each valid. The append refuses past it, so no reader truncates what was written.
 */
export const MAX_FOCUS_ENTRIES = 200;

/** The task-events type of a focus crop's upload, for collab to write into its node. */
export const FOCUS_IMAGE_UPLOAD_EVENT_TYPE = "focus-image-upload";

/** Where a focus crop's upload is going, for collab to write into its node (#1580). */
interface FocusImageUploadTarget {
  type: typeof FOCUS_IMAGE_UPLOAD_EVENT_TYPE;
  /** The canvas Space document holding the node. */
  docName: string;
  /** The node whose reference list takes the crop. */
  nodeId: string;
}

/**
 * A focus crop's upload as it moves: `uploading` when it opens (the node shows it as running), `completed` with the
 * address of the registered asset (it moves into the pool), `failed` when it ends without one (it goes).
 */
export type FocusImageUploadEvent =
  | (FocusImageUploadTarget & { state: "uploading"; image: FocusUpload })
  | (FocusImageUploadTarget & { state: "completed"; image: FocusImage })
  | (FocusImageUploadTarget & { state: "failed"; id: string });

/**
 * A side that a crop may have.
 * @param value - The value.
 * @returns Whether it is a finite positive size within bounds.
 */
function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_FOCUS_DIMENSION;
}

/**
 * Whether one value is a focus crop still uploading, read from untrusted data.
 * @param value - The value.
 * @returns True when it carries a non-empty id within bounds, a name within bounds and two valid sides.
 */
export function isValidFocusUpload(value: unknown): value is FocusUpload {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.id === "string" && f.id.length > 0 && f.id.length <= MAX_FOCUS_ID &&
    typeof f.name === "string" && f.name.length <= MAX_FOCUS_NAME &&
    isDimension(f.width) && isDimension(f.height)
  );
}

/**
 * Whether one value is a focus image, read from untrusted data.
 * @param value - The value.
 * @returns True when it is a valid {@link FocusUpload} that also carries a non-empty address within bounds.
 */
export function isValidFocusImage(value: unknown): value is FocusImage {
  if (!isValidFocusUpload(value)) return false;
  const url = (value as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 && url.length <= MAX_FOCUS_URL;
}

/**
 * Narrow an untrusted `focusImages` value to its valid entries: anything but an array is none; the first entry of an
 * id wins; at most {@link MAX_FOCUS_ENTRIES} are kept; each survivor is projected onto a fresh five-field object, so
 * extra properties on a remote entry never ride along.
 * @param raw - The raw `data.focusImages` value, as a plain array.
 * @returns The valid entries.
 */
export function validFocusImages(raw: unknown): FocusImage[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const kept: FocusImage[] = [];
  for (const f of raw) {
    if (kept.length >= MAX_FOCUS_ENTRIES) break;
    if (!isValidFocusImage(f) || seen.has(f.id)) continue;
    seen.add(f.id);
    kept.push({ id: f.id, url: f.url, name: f.name, width: f.width, height: f.height });
  }
  return kept;
}

/**
 * Narrow an untrusted `focusUploads` value to its valid entries, as {@link validFocusImages} does for the pool.
 * @param raw - The raw `data.focusUploads` value, as a plain array.
 * @returns The valid entries, each a fresh four-field object, the first of an id kept.
 */
export function validFocusUploads(raw: unknown): FocusUpload[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const kept: FocusUpload[] = [];
  for (const f of raw) {
    if (kept.length >= MAX_FOCUS_ENTRIES) break;
    if (!isValidFocusUpload(f) || seen.has(f.id)) continue;
    seen.add(f.id);
    kept.push({ id: f.id, name: f.name, width: f.width, height: f.height });
  }
  return kept;
}

const dimension = z.number().finite().positive().max(MAX_FOCUS_DIMENSION);

/** Half of a surrogate pair with no other half, as a name clipped by UTF-16 units can end. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The image a crop's upload ticket says it will become: the node whose pool takes it, the id the page started it under
 * and the parts of the image the address is added to once registered.
 */
export const focusImageTicketSchema = z
  .object({
    nodeId: z.string().min(1).max(MAX_FOCUS_ID),
    id: z.string().uuid(),
    // Stored in jsonb, which refuses half a surrogate pair; replaced as a text column's UTF-8 encoding does.
    name: z.string().max(MAX_FOCUS_NAME).transform((name) => name.replace(LONE_SURROGATE, "\uFFFD")),
    width: dimension,
    height: dimension,
  })
  .strict();

/** What a focus crop's ticket names. */
export type FocusImageTicket = z.infer<typeof focusImageTicketSchema>;
