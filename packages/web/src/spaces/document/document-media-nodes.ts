// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Video and audio nodes for the document editor.
 *
 * TipTap ships an `image` extension but none for video or audio, so the two
 * are defined here. They are registered from the very first release even
 * though the UI that inserts and renders them arrives in a later slice —
 * y-tiptap deletes any node its schema does not recognise and commits that
 * deletion as an ordinary local change, so a client whose schema lags behind
 * would silently destroy media another client had inserted. Registering the
 * whole schema up front removes that failure mode entirely.
 *
 * These definitions carry no node view: they render as plain `<video>` /
 * `<audio>` elements until the media slice attaches the shared `MediaPlayer`.
 */

import { Node, mergeAttributes } from '@tiptap/core';

/** Shared node spec fields — both media kinds are block-level, opaque units. */
const MEDIA_NODE_BASE = {
  group: 'block',
  // Atom: the node has no editable interior. A caption, if it ever ships,
  // becomes a separate attribute rather than child content.
  atom: true,
  draggable: true,
  selectable: true,
} as const;

/**
 * A video embedded in the document body — a block-level atom carrying the
 * source URL plus the poster frame extracted at upload time.
 *
 * `poster` exists from the first release because an unknown ATTRIBUTE is
 * dropped by the same mechanism that drops an unknown node: a client whose
 * schema lacks the attribute would strip the cover from every video it syncs.
 */
export const Video = Node.create({
  name: 'video',
  ...MEDIA_NODE_BASE,

  addAttributes() {
    return {
      src: { default: null },
      // Cover frame; the upload path pairs every video with one.
      poster: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'video[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: 'true' })];
  },
});

/**
 * An audio clip embedded in the document body — a block-level atom carrying
 * the source URL.
 */
export const Audio = Node.create({
  name: 'audio',
  ...MEDIA_NODE_BASE,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes(HTMLAttributes, { controls: 'true' })];
  },
});
