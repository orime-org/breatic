// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The node and attribute names a prompt is stored under, in the editor and in
 * Yjs. The editor extensions in web declare their schema with these names, and
 * every reader of a stored prompt fragment matches on them.
 */

/** The node name a note is stored under, in the editor and in Yjs. */
export const PROMPT_NOTE_NODE = 'promptNote';

/** The attribute holding a note's words. */
export const PROMPT_NOTE_LABEL_ATTR = 'label';

/** The paragraph attribute holding a line's speaker, from 1. */
export const SPEAKER_ATTR = 'speaker';

/** ProseMirror / TipTap node name for a reference mention chip. */
export const REFERENCE_MENTION_NODE = 'referenceMention';

/** Attr key on a reference-mention node carrying the id of what it refers to. */
export const MENTION_SOURCE_ID_ATTR = 'sourceNodeId';

/** Attr key on a reference-mention node carrying the snapshot thumbnail URL. */
export const MENTION_THUMBNAIL_ATTR = 'thumbnail';
/** Attr key on a reference-mention node carrying the source node's display name. */
export const MENTION_LABEL_ATTR = 'label';
/** Attr key on a reference-mention node carrying the source node modality (icon fallback). */
export const MENTION_KIND_ATTR = 'kind';
