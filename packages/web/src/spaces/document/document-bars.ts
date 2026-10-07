// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which bar the document shows, one at a time (inner#1127).
 *
 * Three kinds of bar float over the body: a media block's toolbar, the link
 * toolbar and the selection bubble bar. Each decides on its own whether it has
 * something to show; this is the one place they read whether another bar has
 * the screen. The order is fixed:
 *
 * 1. a media block the pointer is on — its toolbar, and nothing else;
 * 2. otherwise the link toolbar, when it is up;
 * 3. otherwise whatever the selection raises: a selected media block's
 *    toolbar, or the bubble bar.
 *
 * The bubble bar and the link toolbar already keep apart through the
 * selection (`yielding` in `DocumentEditor`); this adds the media blocks.
 */

import * as React from 'react';

import { keyedStore } from '@web/lib/keyed-store';

/** What the bars read. */
export interface DocumentBars {
  /** The container of the media block the pointer is on, or null. */
  readonly hoveredMedia: HTMLElement | null;
  /** Whether the link toolbar is up. */
  readonly linkToolbarUp: boolean;
}

const NONE: DocumentBars = { hoveredMedia: null, linkToolbarUp: false };

/** Keyed by editor, so an editor that is dropped takes its state with it. */
const store = keyedStore<object, DocumentBars>(
  () => NONE,
  (a, b) => a.hoveredMedia === b.hoveredMedia && a.linkToolbarUp === b.linkToolbarUp,
);

/**
 * The state as it is now; the same object until it changes.
 * @param editor - The editor.
 * @returns The state.
 */
export function documentBarsOf(editor: object): DocumentBars {
  return store.get(editor);
}

/**
 * Records the pointer arriving on, or leaving, a media block.
 *
 * A leave only counts for the block that holds the hover: moving from one
 * block straight onto the next, the second one's arrival can come first.
 * @param editor - The editor.
 * @param host - The media block's container.
 * @param on - True on arrival, false on leaving.
 */
export function setHoveredMedia(editor: object, host: HTMLElement, on: boolean): void {
  const state = store.get(editor);
  if (on) store.set(editor, { ...state, hoveredMedia: host });
  else if (state.hoveredMedia === host) store.set(editor, { ...state, hoveredMedia: null });
}

/**
 * Records the link toolbar coming up or going down.
 * @param editor - The editor.
 * @param up - Whether it is up.
 */
export function setLinkToolbarUp(editor: object, up: boolean): void {
  store.set(editor, { ...store.get(editor), linkToolbarUp: up });
}

/**
 * Whether a media block's toolbar is the bar on screen.
 * @param bars - The state.
 * @param host - The block's container.
 * @param selected - Whether the block is node-selected.
 * @returns True when its toolbar shows.
 */
export function mediaBarShown(bars: DocumentBars, host: HTMLElement, selected: boolean): boolean {
  return bars.hoveredMedia === null ? selected && !bars.linkToolbarUp : bars.hoveredMedia === host;
}

/**
 * Whether the link toolbar and the selection bubble bar step aside, which they
 * do while a media block is under the pointer.
 * @param bars - The state.
 * @returns True when they do.
 */
export function textBarsStandAside(bars: DocumentBars): boolean {
  return bars.hoveredMedia !== null;
}

/**
 * The state, kept current in a component.
 * @param editor - The editor.
 * @returns The state.
 */
export function useDocumentBars(editor: object): DocumentBars {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(editor, listener),
    [editor],
  );
  return React.useSyncExternalStore(subscribe, () => documentBarsOf(editor));
}
