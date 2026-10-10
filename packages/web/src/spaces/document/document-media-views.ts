// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The media blocks one editor is drawing, for the page to render into
 * (inner#1127).
 *
 * A media block's node view builds only its container and enters it here.
 * `DocumentMediaViews` renders every entry into its container through a
 * portal, so the blocks are part of the page's React tree and take its
 * context — the one tooltip provider, the language — the way Tiptap's own
 * React node views do. A root of their own would stand outside all of it.
 */

import { keyedStore } from '@web/lib/keyed-store';
import { setHoveredMedia } from '@web/spaces/document/document-bars';
import type {
  MediaBlockActions,
  MediaBlockProps,
} from '@web/spaces/document/DocumentMediaBlock';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';

/** What one container shows. */
export interface MediaViewEntry {
  readonly type: MediaBlockType;
  readonly props: MediaBlockProps;
  readonly selected: boolean;
  readonly actions: MediaBlockActions;
}

/** One editor's containers and what each shows, in the order they came in. */
type Views = readonly (readonly [HTMLElement, MediaViewEntry])[];

const NO_VIEWS: Views = [];

/** Keyed by editor, so an editor that is dropped takes its entries with it. */
const store = keyedStore<object, Views>(() => NO_VIEWS);

/** One key per container, for the life of the container. */
const keys = new WeakMap<HTMLElement, string>();
let lastKey = 0;

/**
 * The key the portal into a container is rendered under. React matches
 * portals by key, so a block taken out ahead of this one leaves this one's
 * player — and a video playing in it — as it was.
 * @param host - The container.
 * @returns Its key.
 */
export function mediaViewKey(host: HTMLElement): string {
  let key = keys.get(host);
  if (key === undefined) {
    lastKey += 1;
    key = String(lastKey);
    keys.set(host, key);
  }
  return key;
}

/**
 * Enters or replaces what one container shows.
 * @param editor - The editor.
 * @param host - The container.
 * @param entry - What it shows.
 */
export function putMediaView(editor: object, host: HTMLElement, entry: MediaViewEntry): void {
  const views = store.get(editor);
  const at = views.findIndex(([held]) => held === host);
  store.set(
    editor,
    at < 0 ? [...views, [host, entry]] : views.map((view, k) => (k === at ? [host, entry] : view)),
  );
}

/**
 * Takes a container out, when its node view goes.
 * @param editor - The editor.
 * @param host - The container.
 */
export function dropMediaView(editor: object, host: HTMLElement): void {
  // A block taken away under the pointer gets no leave event.
  setHoveredMedia(editor, host, false);
  const views = store.get(editor);
  if (views.some(([held]) => held === host)) {
    store.set(editor, views.filter(([held]) => held !== host));
  }
}

/**
 * Every container and what it shows; the same array until one changes.
 * @param editor - The editor.
 * @returns The entries.
 */
export function mediaViewsOf(editor: object): Views {
  return store.get(editor);
}

/**
 * Hears about every change to one editor's entries.
 * @param editor - The editor.
 * @param listener - Called after each change.
 * @returns The function that stops it.
 */
export function onMediaViewsChange(editor: object, listener: () => void): () => void {
  return store.subscribe(editor, listener);
}
