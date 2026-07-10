// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * TipTap custom node for an `@`-picked reference image in the prompt. It renders
 * inline as a small thumbnail chip (design 2026-07-10 §2.2 — option A, no `#N`
 * numbering). The chip is an atom: it stores the STABLE `sourceNodeId` (used for
 * the execute payload + cascade-delete) plus a snapshot `thumbnail` / `label`
 * for display. The t2i grey-out (§2.4 option C) is applied by the editor
 * container's `data-mode` + CSS, so the chip itself never reads the mode.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import { ImageOff } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
} from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

/** Options for the {@link ReferenceMention} node. */
export interface ReferenceMentionOptions {
  /**
   * The `@` suggestion config, installed as a ProseMirror plugin so typing `@`
   * opens the picker. Supplied via `.configure({ suggestion })`; `editor` is
   * injected by the node itself (see addProseMirrorPlugins).
   */
  suggestion: Omit<SuggestionOptions<ReferenceRailItem>, 'editor'>;
}

/** Attr key on a reference-mention node carrying the snapshot thumbnail URL. */
export const MENTION_THUMBNAIL_ATTR = 'thumbnail';
/** Attr key on a reference-mention node carrying the source node's display name. */
export const MENTION_LABEL_ATTR = 'label';

/**
 * Inline chip NodeView for an `@`-picked reference image: a small thumbnail (or
 * a broken-image fallback) labelled by the source node name. Rendered by
 * ReactNodeViewRenderer; `data-reference-mention` marks it for the CSS t2i
 * grey-out. Non-editable content — the atom node is selected/deleted as a unit.
 * @param root0 - NodeView props from TipTap.
 * @param root0.node - The reference-mention ProseMirror node.
 * @returns The inline thumbnail chip.
 */
function ReferenceMentionChip({ node }: NodeViewProps): React.JSX.Element {
  const t = useTranslation();
  const thumbnail = node.attrs[MENTION_THUMBNAIL_ATTR] as string | null;
  // Localized fallback for a source node with no display name (nameOf → '')
  // instead of a hardcoded English literal (i18n mandate). useTranslation is a
  // global-store hook, so it works inside this ReactNodeView.
  const label =
    (node.attrs[MENTION_LABEL_ATTR] as string | null) ||
    t('canvas.generatePanel.reference');
  return (
    <NodeViewWrapper
      as='span'
      data-reference-mention=''
      className='reference-mention mx-0.5 inline-flex h-5 max-w-[10rem] select-none items-center gap-1 overflow-hidden rounded-full border border-border bg-muted pl-1 align-middle text-xs text-muted-foreground'
      contentEditable={false}
    >
      {typeof thumbnail === 'string' && thumbnail.length > 0 ? (
        <img
          src={thumbnail}
          alt={label}
          className='h-3.5 w-3.5 shrink-0 rounded-sm object-cover'
          draggable={false}
        />
      ) : (
        <ImageOff className='h-3 w-3 shrink-0' aria-hidden='true' />
      )}
      <span className='truncate pr-1.5'>{label}</span>
    </NodeViewWrapper>
  );
}

/**
 * The reference-mention custom node: an inline, atomic, non-draggable node
 * carrying a stable `sourceNodeId` + snapshot `thumbnail` / `label`. Under the
 * Collaboration (Yjs) extension the node + its attributes sync automatically
 * because they are part of the shared ProseMirror schema. Insertion is driven
 * by the `@` suggestion, which this extension INSTALLS as a ProseMirror plugin
 * (addProseMirrorPlugins) — the `.configure({ suggestion })` config alone does
 * nothing until it is wired into the editor as a plugin.
 */
export const ReferenceMention = Node.create<ReferenceMentionOptions>({
  name: REFERENCE_MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      // Overridden by .configure({ suggestion: makeReferenceSuggestion(...) }).
      suggestion: {} as Omit<SuggestionOptions<ReferenceRailItem>, 'editor'>,
    };
  },

  addAttributes() {
    return {
      [MENTION_SOURCE_ID_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-source-id'),
        renderHTML: (attrs) =>
          attrs[MENTION_SOURCE_ID_ATTR]
            ? { 'data-source-id': attrs[MENTION_SOURCE_ID_ATTR] as string }
            : {},
      },
      [MENTION_THUMBNAIL_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-thumbnail'),
        renderHTML: (attrs) =>
          attrs[MENTION_THUMBNAIL_ATTR]
            ? { 'data-thumbnail': attrs[MENTION_THUMBNAIL_ATTR] as string }
            : {},
      },
      [MENTION_LABEL_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (attrs) =>
          attrs[MENTION_LABEL_ATTR]
            ? { 'data-label': attrs[MENTION_LABEL_ATTR] as string }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-reference-mention]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-reference-mention': '' }, HTMLAttributes),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ReferenceMentionChip);
  },

  addProseMirrorPlugins() {
    // Install the `@` suggestion plugin (the missing wiring that made typing `@`
    // do nothing). `editor` is injected here; the rest (char / items / command /
    // render) comes from makeReferenceSuggestion via .configure.
    return [
      Suggestion<ReferenceRailItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
