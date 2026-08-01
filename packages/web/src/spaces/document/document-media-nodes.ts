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
 * These definitions carry no node view yet — the media slice attaches the
 * shared `MediaPlayer`. Neither renders `controls`: a browser-drawn transport
 * bar looks different in every engine, which the project forbids outright, and
 * the player that replaces it is self-drawn.
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
 * `width` and `height` are here for the same reason and none other — nothing
 * writes them yet. The media slice lets an author size block media, and the
 * image node has carried them since day one; a video sized on a newer bundle
 * would otherwise snap back to default on every older client that touches the
 * document. An attribute nothing writes is inert; an attribute nothing
 * declared is a data loss.
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
      width: { default: null },
      height: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'video[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes)];
  },
});

/**
 * An audio clip embedded in the document body — a block-level atom carrying
 * the source URL.
 *
 * Carries `width` / `height` for the same reason the video does: a player
 * occupies a box the author can size, and an attribute that is not declared
 * from the first release cannot be added later without older clients erasing
 * it. Nothing writes them yet.
 */
export const Audio = Node.create({
  name: 'audio',
  ...MEDIA_NODE_BASE,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes(HTMLAttributes)];
  },
});
