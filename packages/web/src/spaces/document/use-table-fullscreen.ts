// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Full screen as a component reads it (#1427).
 *
 * Opening and ending full screen by command can be transactions carrying
 * nothing but a meta, which the editor's change events do not report; the
 * plugin's own view sees every change of its state, those included.
 */

import * as React from 'react';
import type { EditorState } from '@tiptap/pm/state';

import {
  tableFullscreenIn,
  tableFullscreenWatch,
  type TableFullscreen,
} from '@web/spaces/document/document-table-fullscreen';

/** The editor a component holds: one that can hand over its state. */
interface StateEditor {
  readonly prosemirrorState: EditorState;
}

/**
 * Full screen in this editor, kept current.
 * @param editor - The document editor.
 * @returns The full-screen state.
 */
export function useTableFullscreen(editor: StateEditor): TableFullscreen {
  return React.useSyncExternalStore(tableFullscreenWatch.onChange, () => tableFullscreenIn(editor.prosemirrorState));
}
