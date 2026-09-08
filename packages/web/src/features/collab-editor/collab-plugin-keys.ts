// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `@tiptap/y-tiptap` plugin keys, in one place, for the readers that reach
 * into y-prosemirror's plugin state and its per-transaction meta: the shared
 * undo-selection restore, the prompt editor's local-user-input tracker, and its
 * chip-boundary caret.
 *
 * ## Why the keys and not their names
 *
 * `PluginKey` does not guarantee the name it is asked for. `prosemirror-state`
 * keeps one process-wide table and appends a number when a name is already
 * taken. `@tiptap/y-tiptap` and `y-prosemirror` both ask for `y-sync` and
 * `y-undo`, and this build loads BOTH — the document body is on y-prosemirror
 * through BlockNote, the canvas prompt and text-node editors are still on
 * y-tiptap. Whichever module the bundler puts first takes the bare name; the
 * other gets the suffix. Measured with y-prosemirror first: it takes `y-sync$`
 * and y-tiptap mints `y-sync$1`.
 *
 * A name lookup therefore stops being an answer to "which plugin is this". The
 * keys are, because `getState` and `getMeta` match on identity. Importing them
 * is safe for the reason a name lookup used to be preferred over: `single-copy`
 * is enforced by `__tests__/single-y-tiptap-copy`, so the copy imported here is
 * the copy the collaboration extensions register with.
 *
 * A miss is SILENT in all three readers — the undo selection restore stops
 * restoring, the input tracker stops telling a remote change from a local one —
 * which is why this is worth a module rather than three imports.
 */

export { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
