// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adding one image to a node's focus pool (#1782, #1580), run by collab when a crop's upload is registered.
 *
 * `focusImages` is a `Y.Array`, a CRDT sequence, so two crops added at once both stay. A pool still stored as a plain
 * array (an early document) is converted, through the shared sanitizer, into a `Y.Array` on its first add.
 */

import * as Y from "yjs";
import { isValidFocusImage, MAX_FOCUS_ENTRIES, validFocusImages } from "@shared/canvas/focus-images.js";
import type { FocusImage } from "@shared/types/canvas-node.js";

/**
 * Append a focus image to a node's pool. Call inside an open transaction.
 * @param data - The node's data map.
 * @param image - The image.
 * @returns `added`; or why nothing was written: an image the readers would drop, one whose id the pool already holds,
 *   or a pool at the ceiling.
 */
export function appendFocusImageCore(
  data: Y.Map<unknown>,
  image: FocusImage,
): "added" | "invalid-entry" | "duplicate" | "pool-full" {
  if (!isValidFocusImage(image)) return "invalid-entry";
  const raw = data.get("focusImages");
  const list = validFocusImages(raw instanceof Y.Array ? raw.toArray() : raw);
  if (list.some((f) => f.id === image.id)) return "duplicate";
  if (list.length >= MAX_FOCUS_ENTRIES) return "pool-full";
  const entry: FocusImage = { id: image.id, url: image.url, name: image.name, width: image.width, height: image.height };
  if (raw instanceof Y.Array) {
    raw.push([entry]);
  } else {
    const arr = new Y.Array<FocusImage>();
    arr.push([...list, entry]);
    data.set("focusImages", arr);
  }
  return "added";
}
