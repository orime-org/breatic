// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Adding one image to a node's focus pool (#1782, #1580), and the crop's upload state beside it, both run by collab.
 *
 * `focusImages` is a `Y.Array`, a CRDT sequence, so two crops added at once both stay. A pool still stored as a plain
 * array (an early document) is converted, through the shared sanitizer, into a `Y.Array` on its first add.
 */

import * as Y from "yjs";
import {
  isValidFocusImage,
  isValidFocusUpload,
  MAX_FOCUS_ENTRIES,
  validFocusImages,
  validFocusUploads,
  type FocusImageUploadEvent,
} from "@shared/canvas/focus-images.js";
import type { FocusImage, FocusUpload } from "@shared/types/canvas-node.js";

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

/**
 * The crop ids a node's raw list holds, read through the matching sanitizer.
 * @param raw - A `focusImages` or `focusUploads` value.
 * @param read - The sanitizer for that list.
 * @returns The ids.
 */
function idsIn(raw: unknown, read: (value: unknown) => Array<{ id: string }>): Set<string> {
  return new Set(read(raw instanceof Y.Array ? raw.toArray() : raw).map((f) => f.id));
}

/**
 * Take off the node's uploading list every entry a test picks, and every entry no reader would show.
 * @param data - The node's data map.
 * @param gone - Whether a valid entry goes.
 */
function dropUploads(data: Y.Map<unknown>, gone: (upload: FocusUpload) => boolean): void {
  const raw = data.get("focusUploads");
  if (!(raw instanceof Y.Array)) {
    if (Array.isArray(raw)) data.set("focusUploads", Y.Array.from(validFocusUploads(raw).filter((u) => !gone(u))));
    return;
  }
  const items = raw.toArray();
  for (let i = items.length - 1; i >= 0; i--) {
    const item: unknown = items[i];
    if (!isValidFocusUpload(item) || gone(item)) raw.delete(i, 1);
  }
}

/**
 * Take a crop off the node's uploading list, wherever it stands in it.
 * @param data - The node's data map.
 * @param id - The crop's id.
 */
function dropUpload(data: Y.Map<unknown>, id: string): void {
  dropUploads(data, (u) => u.id === id);
}

/**
 * Take off the node's uploading list every crop whose time is up, as a task row past its budget is over.
 * @param data - The node's data map.
 * @param now - The instant to judge by, from the database's clock.
 */
function dropOverdue(data: Y.Map<unknown>, now: number): void {
  dropUploads(data, (u) => u.deadlineAt <= now);
}

/**
 * Write one step of a focus crop's upload into its node, as a task row's counts are written: `uploading` shows it in
 * `focusUploads`, `completed` moves it into the pool and `failed` takes it away, the pool untouched. Call inside an
 * open transaction, so a crop that moves is never in both lists or in neither.
 * @param data - The node's data map.
 * @param event - The step.
 */
export function applyFocusImageUpload(data: Y.Map<unknown>, event: FocusImageUploadEvent): void {
  if (event.state === "uploading") {
    const { image, openedAt } = event;
    if (!isValidFocusUpload(image) || idsIn(data.get("focusImages"), validFocusImages).has(image.id)) return;
    dropOverdue(data, openedAt);
    const raw = data.get("focusUploads");
    const held = idsIn(raw, validFocusUploads);
    if (held.has(image.id) || held.size >= MAX_FOCUS_ENTRIES) return;
    const entry: FocusUpload = { id: image.id, name: image.name, width: image.width, height: image.height, deadlineAt: image.deadlineAt };
    if (raw instanceof Y.Array) raw.push([entry]);
    else data.set("focusUploads", Y.Array.from([...validFocusUploads(raw), entry]));
    return;
  }
  if (event.state === "completed") appendFocusImageCore(data, event.image);
  dropUpload(data, event.state === "completed" ? event.image.id : event.id);
}
