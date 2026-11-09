// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A table opened full screen (breatic#1427). Placeholder exports while the
 * tests are written; the plugin itself comes next.
 */

import type { EditorState } from '@tiptap/pm/state';

/** Where the body goes back to once full screen has ended. */
export type FullscreenReturn =
  | { readonly kind: 'table'; readonly id: string; readonly offset: number }
  | { readonly kind: 'scrollTop'; readonly value: number }
  | { readonly kind: 'selection' };

/** Full screen as the plugin keeps it. */
export type TableFullscreen =
  | { readonly table: string; readonly scrollTop: number; readonly offset: number }
  | { readonly table: null; readonly returnTo: FullscreenReturn | null };

/** An entry into full screen. */
export interface FullscreenEntry {
  /** The table's block id. */
  readonly table: string;
  /** The body scroller's `scrollTop` at entry. */
  readonly scrollTop: number;
  /** How far the table's top stood below the scroller's top at entry. */
  readonly offset: number;
}

/**
 * Full screen in this state.
 * @param _state - The editor state.
 * @returns The full-screen state.
 */
export function tableFullscreenIn(_state: EditorState): TableFullscreen {
  return { table: null, returnTo: null };
}

/**
 * Opens a table full screen, or ends full screen.
 * @param _editor - The editor.
 * @param _entry - The table and where the body was, or null to end it.
 */
export function setTableFullscreen(_editor: unknown, _entry: FullscreenEntry | null): void {}

/**
 * Forgets where to return once the shell has scrolled there.
 * @param _editor - The editor.
 */
export function clearFullscreenReturn(_editor: unknown): void {}
