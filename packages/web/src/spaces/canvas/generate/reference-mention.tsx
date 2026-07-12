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

import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
} from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { createReferenceMentionCaret } from '@web/spaces/canvas/generate/reference-mention-caret';
import { ThumbnailHoverPreview } from '@web/spaces/canvas/generate/ThumbnailHoverPreview';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';
import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/** Options for the {@link ReferenceMention} node. */
export interface ReferenceMentionOptions {
  /**
   * The `@` suggestion config, installed as a ProseMirror plugin so typing `@`
   * opens the picker. Supplied via `.configure({ suggestion })`; `editor` is
   * injected by the node itself (see addProseMirrorPlugins).
   */
  suggestion: Omit<SuggestionOptions<ReferenceRailItem>, 'editor'>;
  /**
   * Reads the CURRENT reference pool — the chip's hover preview resolves a
   * text reference's live content through it (spec §9.1) instead of freezing
   * the content into an attr that would go stale on later edits.
   */
  getPool?: () => ReferenceRailItem[];
}

/** Attr key on a reference-mention node carrying the snapshot thumbnail URL. */
export const MENTION_THUMBNAIL_ATTR = 'thumbnail';
/** Attr key on a reference-mention node carrying the source node's display name. */
export const MENTION_LABEL_ATTR = 'label';
/** Attr key on a reference-mention node carrying the source node modality (icon fallback). */
export const MENTION_KIND_ATTR = 'kind';

/**
 * Builds the ProseMirror content for a reference-mention atom from a pool row,
 * so the `@` suggestion and the click-to-insert path (reference rail) stay in
 * sync on the exact same attrs. No trailing space is added (user 2026-07-10:
 * no auto space) — the gap between adjacent chips stays reachable via the
 * chip-boundary caret plugin (reference-mention-caret.ts).
 * @param item - The picked reference pool row.
 * @returns The reference-mention node content (attrs = id / thumbnail / label / kind).
 */
export function referenceMentionContent(item: ReferenceRailItem): {
  type: string;
  attrs: Record<string, string | null>;
} {
  return {
    type: REFERENCE_MENTION_NODE,
    attrs: {
      [MENTION_SOURCE_ID_ATTR]: item.sourceNodeId,
      [MENTION_THUMBNAIL_ATTR]: item.thumbnail ?? null,
      [MENTION_LABEL_ATTR]: item.sourceNodeName || null,
      [MENTION_KIND_ATTR]: item.sourceNodeType,
    },
  };
}

/**
 * Serializes the prompt for the BACKEND (spec §9.1, user 2026-07-10): the chip
 * stays a chip in the editor, but the string sent to generation substitutes a
 * TEXT chip with its source text node's current content — "@ a text node" means
 * "insert that node's words here". An image chip contributes nothing to the
 * string (it feeds the i2i source-image subset instead), and a text chip whose
 * pool row vanished (edge removed mid-flight) or whose node is empty resolves
 * to an empty string. Pool content is read at CALL time, so invoking this at
 * execute-click picks up the text node's latest words even when the prompt doc
 * itself never changed.
 * @param editor - The prompt editor.
 * @param pool - The current reference pool (source of live text content).
 * @returns The backend-bound prompt string.
 */
export function serializePromptText(
  editor: Editor,
  pool: ReadonlyArray<ReferenceRailItem>,
): string {
  const textById = new Map(
    pool
      .filter((r) => r.sourceNodeType === 'text')
      .map((r) => [r.sourceNodeId, r.textContent ?? '']),
  );
  return editor.getText({
    textSerializers: {
      [REFERENCE_MENTION_NODE]: ({ node }): string => {
        if (node.attrs[MENTION_KIND_ATTR] !== 'text') return '';
        const id = node.attrs[MENTION_SOURCE_ID_ATTR] as string | null;
        return (id != null ? textById.get(id) : undefined) ?? '';
      },
    },
  });
}

/**
 * Inline chip NodeView for an `@`-picked reference image: a small thumbnail (or
 * a broken-image fallback) labelled by the source node name. Rendered by
 * ReactNodeViewRenderer; `data-reference-mention` marks it for the CSS t2i
 * grey-out. Non-editable content — the atom node is selected/deleted as a unit.
 * @param root0 - NodeView props from TipTap.
 * @param root0.node - The reference-mention ProseMirror node.
 * @param root0.extension - The ReferenceMention extension (carries getPool).
 * @returns The inline thumbnail chip.
 */
function ReferenceMentionChip({
  node,
  extension,
}: NodeViewProps): React.JSX.Element {
  const t = useTranslation();
  const thumbnail = node.attrs[MENTION_THUMBNAIL_ATTR] as string | null;
  const kind = node.attrs[MENTION_KIND_ATTR] as NodeKind | null;
  // Localized fallback for a source node with no display name (nameOf → '')
  // instead of a hardcoded English literal (i18n mandate). useTranslation is a
  // global-store hook, so it works inside this ReactNodeView.
  const label =
    (node.attrs[MENTION_LABEL_ATTR] as string | null) ||
    t('canvas.generatePanel.reference');
  // A non-image source (text / audio / …) has no thumbnail — show its modality
  // icon rather than a broken-image placeholder. Old mentions carry no kind, so
  // default to image (the historical @-picker was image-centric).
  const FallbackIcon = getNodeIcon(kind ?? 'image');
  // Text-reference hover (spec §9.1): resolve the source node's content LIVE
  // from the pool (not from an attr snapshot). Read at render — the small
  // staleness window (source edited while this chip never re-rendered) only
  // affects the preview; the backend serialization resolves live at execute.
  const sourceId = node.attrs[MENTION_SOURCE_ID_ATTR] as string | null;
  const options = extension.options as ReferenceMentionOptions;
  const textContent =
    kind === 'text' && sourceId != null
      ? options.getPool?.().find((r) => r.sourceNodeId === sourceId)
        ?.textContent
      : undefined;
  return (
    <ThumbnailHoverPreview
      src={thumbnail ?? undefined}
      text={textContent}
      alt={label}
    >
      <NodeViewWrapper
        as='span'
        data-reference-mention=''
        // data-kind lets the t2i grey-out target IMAGE chips only — a text
        // chip's substitution still takes effect in t2i (round-2 adversarial).
        data-kind={kind ?? 'image'}
        className='reference-mention mx-0.5 inline-flex h-5 max-w-[10rem] select-none items-center gap-1 overflow-hidden rounded-full border border-border bg-muted pl-1 align-middle text-xs text-muted-foreground'
        contentEditable={false}
      >
        {typeof thumbnail === 'string' && thumbnail.length > 0 ? (
          <img
            src={thumbnail}
            alt={label}
            className='h-3.5 w-3.5 shrink-0 rounded object-cover'
            draggable={false}
          />
        ) : (
          <FallbackIcon className='h-3 w-3 shrink-0' aria-hidden='true' />
        )}
        <span className='truncate pr-1.5'>{label}</span>
      </NodeViewWrapper>
    </ThumbnailHoverPreview>
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
      [MENTION_KIND_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-kind'),
        renderHTML: (attrs) =>
          attrs[MENTION_KIND_ATTR]
            ? { 'data-kind': attrs[MENTION_KIND_ATTR] as string }
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
    // render) comes from makeReferenceSuggestion via .configure. The caret
    // plugin makes the gap between adjacent chips clickable and visible —
    // browsers cannot paint a native caret with no text node to anchor to.
    return [
      Suggestion<ReferenceRailItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
      createReferenceMentionCaret(),
    ];
  },
});
