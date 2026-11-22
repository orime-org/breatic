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
import type { FocusImage } from "@shared/types/canvas-node.js";

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

/** The task-events type of a crop handed to collab. */
export const FOCUS_IMAGE_UPLOAD_EVENT_TYPE = "focus-image-upload";

/** A registered focus crop, for collab to add to its node's pool. */
export interface FocusImageUploadEvent {
  type: typeof FOCUS_IMAGE_UPLOAD_EVENT_TYPE;
  /** The canvas Space document holding the node. */
  docName: string;
  /** The node whose pool takes the image. */
  nodeId: string;
  /** The image, its address taken from the registered asset. */
  image: FocusImage;
}

/**
 * A side that a crop may have.
 * @param value - The value.
 * @returns Whether it is a finite positive size within bounds.
 */
function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_FOCUS_DIMENSION;
}

/**
 * Whether one value is a focus image, read from untrusted data.
 * @param value - The value.
 * @returns True when it carries a non-empty id and address within bounds, a name within bounds and two valid sides.
 */
export function isValidFocusImage(value: unknown): value is FocusImage {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.id === "string" && f.id.length > 0 && f.id.length <= MAX_FOCUS_ID &&
    typeof f.url === "string" && f.url.length > 0 && f.url.length <= MAX_FOCUS_URL &&
    typeof f.name === "string" && f.name.length <= MAX_FOCUS_NAME &&
    isDimension(f.width) && isDimension(f.height)
  );
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

const dimension = z.number().finite().positive().max(MAX_FOCUS_DIMENSION);

/**
 * The image a crop's upload ticket says it will become: the node whose pool takes it, the id the page started it under
 * and the parts of the image the address is added to once registered.
 */
export const focusImageTicketSchema = z
  .object({
    nodeId: z.string().min(1).max(MAX_FOCUS_ID),
    id: z.string().uuid(),
    name: z.string().max(MAX_FOCUS_NAME),
    width: dimension,
    height: dimension,
  })
  .strict();

/** What a focus crop's ticket names. */
export type FocusImageTicket = z.infer<typeof focusImageTicketSchema>;
