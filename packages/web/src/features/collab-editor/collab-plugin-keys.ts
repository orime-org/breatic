// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * y-prosemirror plugin-key NAMES, located by string rather than by importing
 * `ySyncPluginKey` / `yUndoPluginKey`. Read by the shared undo-selection
 * restore, which every collaborative editor carries, and by the prompt
 * editor's own local-user-input tracker and chip-boundary caret — all of which
 * reach y-prosemirror's internal state (and its per-transaction meta) through
 * these names.
 *
 * WHY BY NAME, and its LIMIT (do not overclaim): a name lookup is robust
 * against importing a DIFFERENT `@tiptap/y-tiptap` instance than the one the
 * active plugin registered with — the imported key object would not match, the
 * name still would. (`@tiptap/y-tiptap` is a direct dependency of `web`, pinned
 * through the catalog; the risk is the collaboration extensions resolving their
 * own copy, not us importing a stray transitive one.)
 *
 * It is NOT robust against a DUPLICATE COPY entering the bundle — pnpm would
 * then mint the active key as `y-sync$1`, and a lookup for `y-sync$` returns
 * undefined (a SILENT miss: the reader treats the change as local / the binding
 * as absent). Only `collab-undo-selection` dev-warns on that miss. Single-copy
 * is enforced by `__tests__/single-y-tiptap-copy`, which checks both
 * collaboration extensions resolve the same copy we do. Centralized here so
 * the magic strings + this caveat live in ONE place (adversarial ②: the names
 * and their rationale were previously duplicated across the three files).
 */

/** The y-prosemirror sync plugin's key name (`ySyncPluginKey.key`). */
export const Y_SYNC_PLUGIN_KEY_NAME = 'y-sync$';

/** The y-prosemirror undo plugin's key name (`yUndoPluginKey.key`). */
export const Y_UNDO_PLUGIN_KEY_NAME = 'y-undo$';
