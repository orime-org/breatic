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

import { setHoveredMedia } from '@web/spaces/document/document-bars';
import type {
  MediaBlockActions,
  MediaBlockProps,
  MediaBlockType,
} from '@web/spaces/document/DocumentMediaBlock';

/** What one container shows. */
export interface MediaViewEntry {
  readonly type: MediaBlockType;
  readonly props: MediaBlockProps;
  readonly selected: boolean;
  readonly actions: MediaBlockActions;
}

/** One editor's entries, and who listens to them. */
interface Registry {
  readonly entries: Map<HTMLElement, MediaViewEntry>;
  snapshot: readonly (readonly [HTMLElement, MediaViewEntry])[];
  readonly listeners: Set<() => void>;
}

/** Keyed by editor, so an editor that is dropped takes its entries with it. */
const registries = new WeakMap<object, Registry>();

/**
 * One editor's registry, made on first use.
 * @param editor - The editor.
 * @returns Its registry.
 */
function registryOf(editor: object): Registry {
  let registry = registries.get(editor);
  if (registry === undefined) {
    registry = { entries: new Map(), snapshot: [], listeners: new Set() };
    registries.set(editor, registry);
  }
  return registry;
}

/**
 * Takes a new snapshot and tells the listeners.
 * @param registry - The registry that changed.
 */
function changed(registry: Registry): void {
  registry.snapshot = [...registry.entries];
  registry.listeners.forEach((listener) => {
    listener();
  });
}

/**
 * Enters or replaces what one container shows.
 * @param editor - The editor.
 * @param host - The container.
 * @param entry - What it shows.
 */
export function putMediaView(editor: object, host: HTMLElement, entry: MediaViewEntry): void {
  const registry = registryOf(editor);
  registry.entries.set(host, entry);
  changed(registry);
}

/**
 * Takes a container out, when its node view goes.
 * @param editor - The editor.
 * @param host - The container.
 */
export function dropMediaView(editor: object, host: HTMLElement): void {
  const registry = registryOf(editor);
  // A block taken away under the pointer gets no leave event.
  setHoveredMedia(editor, host, false);
  if (registry.entries.delete(host)) changed(registry);
}

/**
 * Every container and what it shows; the same array until one changes.
 * @param editor - The editor.
 * @returns The entries.
 */
export function mediaViewsOf(editor: object): readonly (readonly [HTMLElement, MediaViewEntry])[] {
  return registryOf(editor).snapshot;
}

/**
 * Hears about every change to one editor's entries.
 * @param editor - The editor.
 * @param listener - Called after each change.
 * @returns The function that stops it.
 */
export function onMediaViewsChange(editor: object, listener: () => void): () => void {
  const { listeners } = registryOf(editor);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
