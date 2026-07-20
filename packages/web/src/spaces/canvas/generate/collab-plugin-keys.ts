// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * y-prosemirror plugin-key NAMES, located by string rather than by importing
 * `ySyncPluginKey` / `yUndoPluginKey`. Three collab plugins on the prompt
 * editor — the local-user-input tracker, the chip-boundary caret, and the
 * undo-selection restore — read y-prosemirror internal state (and its
 * per-transaction meta) by these names.
 *
 * WHY BY NAME, and its LIMIT (do not overclaim): a name lookup is robust
 * against importing the WRONG `@tiptap/y-tiptap` instance (a transitive dep
 * whose imported key object differs from the one the active plugin registered).
 * It is NOT robust against a DUPLICATE COPY of `@tiptap/y-tiptap` entering the
 * bundle — pnpm would then mint the active key as `y-sync$1`, and a lookup for
 * `y-sync$` returns undefined (a SILENT miss: the reader treats the change as
 * local / the binding as absent). Only `collab-undo-selection` dev-warns on
 * that miss; the single bundled copy makes it safe today. Centralized here so
 * the magic strings + this caveat live in ONE place (adversarial ②: the names
 * and their rationale were previously duplicated across the three files).
 */

/** The y-prosemirror sync plugin's key name (`ySyncPluginKey.key`). */
export const Y_SYNC_PLUGIN_KEY_NAME = 'y-sync$';

/** The y-prosemirror undo plugin's key name (`yUndoPluginKey.key`). */
export const Y_UNDO_PLUGIN_KEY_NAME = 'y-undo$';
