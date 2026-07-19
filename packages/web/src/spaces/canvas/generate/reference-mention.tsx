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
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import { Crop } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
} from '@web/spaces/canvas/generate/at-reference';
import { FOCUS_REF_PREFIX } from '@web/spaces/canvas/generate/derive-references';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { createReferenceMentionCaret } from '@web/spaces/canvas/generate/reference-mention-caret';
import { createReferenceMentionRangeHighlight } from '@web/spaces/canvas/generate/reference-mention-range-decoration';
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
  /**
   * Whether source images are inert (text-to-image). An IMAGE chip's hover
   * preview greys out when true, to signal it will not be used — the same
   * `dimmed` signal the rail passes (user 2026-07-18). A LIVE getter: the
   * NodeView does not re-render on a mode toggle, so a render-time read would
   * freeze the dim at insert time — it is instead read at hover-open through
   * `resolveDimmed` (#1798). The chip BODY grey-out is separately live: the
   * container (PromptEditor) appends a mode-conditional Tailwind class that
   * greys `.reference-mention[data-kind=image]`, and it re-renders on the mode
   * prop, so only this JS hover-preview path needed the hover-open read.
   */
  getImageRefsDisabled?: () => boolean;
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
 * Strips reference-mention chips whose source node is NOT in `poolIds` from a
 * pasted slice (E, user 2026-07-12), keeping the surrounding text. A chip means
 * "this node references that source", so pasting one into a node not wired to
 * the source (copy from node A's prompt into node B) is a contradiction — drop
 * the chip, keep the words. Chips whose source IS in the pool (same-node paste)
 * survive untouched, mirroring the cascade-clear invariant (a chip must be in
 * the reference pool).
 * @param slice - The pasted slice.
 * @param poolIds - The target node's current reference-pool source ids.
 * @returns A slice with foreign chips removed.
 */
export function stripForeignReferenceChips(
  slice: Slice,
  poolIds: ReadonlySet<string>,
): Slice {
  /**
   * Recursively rebuilds a fragment, dropping foreign reference-mention chips
   * and recursing into block content.
   * @param fragment - The fragment to filter.
   * @returns The fragment without foreign chips.
   */
  const rebuild = (fragment: Fragment): Fragment => {
    const kept: PMNode[] = [];
    fragment.forEach((child) => {
      if (child.type.name === REFERENCE_MENTION_NODE) {
        const id = child.attrs[MENTION_SOURCE_ID_ATTR] as string | null;
        if (typeof id === 'string' && poolIds.has(id)) kept.push(child);
        return; // foreign chip → dropped (its text neighbours stay)
      }
      kept.push(
        child.content.size > 0 ? child.copy(rebuild(child.content)) : child,
      );
    });
    return Fragment.fromArray(kept);
  };
  return new Slice(rebuild(slice.content), slice.openStart, slice.openEnd);
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
  const sourceId = node.attrs[MENTION_SOURCE_ID_ATTR] as string | null;
  // A focus crop's sourceNodeId lives in the `focus:` namespace — show the
  // same crop glyph the rail / @-suggestion use so a standalone focus copy
  // reads apart from a live node reference everywhere (user 2026-07-17).
  const isFocus = sourceId != null && sourceId.startsWith(FOCUS_REF_PREFIX);
  const options = extension.options as ReferenceMentionOptions;
  const isVisual = kind === 'image' || kind === 'video';
  // A visual chip with no thumbnail shows a static "not yet filled" hint. It is
  // attr-backed (the F sync writes the live thumbnail, so this re-computes on the
  // ensuing re-render), so it needs no live resolver and never blanks on the
  // tooltip's fade-out.
  const staticEmptyHint =
    isVisual && !thumbnail
      ? t('canvas.generatePanel.emptyImageReference')
      : undefined;
  // Only a TEXT chip resolves live at hover-open (design 2026-07-12 invariant,
  // decision C; batch-5 I5): its body is NOT a synced attr (freezing it would
  // duplicate it into the Yjs prompt doc), so the NodeView cannot re-render on a
  // source edit — read the pool live on open instead. Image / video read from
  // the synced `src` / `emptyHint` above; an unhandled modality (audio / 3d /
  // web / legacy) passes neither, so it gets NO tooltip rather than an empty box
  // (batch-5 adversarial finding 2).
  const resolveTextHover = React.useCallback((): {
    text?: string;
    emptyHint?: string;
  } => {
    const row =
      sourceId != null
        ? options.getPool?.().find((r) => r.sourceNodeId === sourceId)
        : undefined;
    const content = row?.textContent;
    return content
      ? { text: content }
      : { emptyHint: t('canvas.generatePanel.emptyTextReference') };
  }, [options, sourceId, t]);
  // Live-at-open dim (#1798): an image chip's hover preview greys out when t2i
  // will ignore it. `getImageRefsDisabled` is a live getter, but this NodeView
  // does NOT re-render on a mode toggle, so reading it at render froze the dim at
  // insert time (t2i→i2i left the preview greyed). Passing the getter through as
  // `resolveDimmed` lets ThumbnailHoverPreview read it when the tooltip opens.
  // The chip BODY grey-out is separately live: PromptEditor greys
  // `.reference-mention[data-kind=image]` via a mode-conditional class that
  // re-renders on the mode prop; only this JS hover-preview path needed the fix.
  const resolveDimmed = React.useCallback(
    (): boolean => options.getImageRefsDisabled?.() === true,
    [options],
  );
  return (
    <ThumbnailHoverPreview
      src={thumbnail ?? undefined}
      alt={label}
      emptyHint={staticEmptyHint}
      resolveOnOpen={kind === 'text' ? resolveTextHover : undefined}
      // Grey the preview for an image chip that t2i will ignore (explicit —
      // same mechanism the rail uses; not opacity inheritance). Live at open
      // (resolveDimmed), because the NodeView does not re-render on a mode toggle.
      resolveDimmed={kind === 'image' ? resolveDimmed : undefined}
    >
      <NodeViewWrapper
        as='span'
        data-reference-mention=''
        // The whole atomic chip is its own drag handle: tiptap's stopEvent
        // preventDefault()s a NodeView drag unless the preceding mousedown
        // landed inside a [data-drag-handle] (item ⑥, user 2026-07-14 — a
        // selected chip could not be dragged in any browser).
        data-drag-handle=''
        // data-kind lets the t2i grey-out target IMAGE chips only — a text
        // chip's substitution still takes effect in t2i (round-2 adversarial).
        data-kind={kind ?? 'image'}
        // No horizontal margin: the whitespace invariant (reference-mention-
        // whitespace.ts) keeps a real space on each side, so the chip's spacing
        // comes from that space, not a CSS margin (design 2026-07-13 §6 — avoids
        // margin + space double-gap).
        // h-[18px]: exactly the 18px line pitch so the chip no longer stretches
        // the line box (user 2026-07-14 — a 20px chip made Safari paint the
        // native selection highlight with all the extra space above the text).
        // align value: measured on the real machine to put the chip's
        // centerline exactly on the TEXT centerline (numeric vertical-align;
        // `align-middle` sat it ~1.2px low under Inter 13px metrics).
        className='reference-mention inline-flex h-[18px] max-w-[10rem] select-none items-center gap-1 overflow-hidden rounded-content-xs border border-border bg-muted pl-1 align-[-1.25px] text-xs text-foreground'
        contentEditable={false}
      >
        {typeof thumbnail === 'string' && thumbnail.length > 0 ? (
          <img
            src={thumbnail}
            alt={label}
            className='h-3 w-3 shrink-0 rounded-content-xs object-cover'
            draggable={false}
          />
        ) : (
          <FallbackIcon className='h-3 w-3 shrink-0' aria-hidden='true' />
        )}
        {/* Crop glyph before the name marks a focus copy (user 2026-07-17,
            consistent with the rail + @-suggestion). */}
        {isFocus ? (
          <>
            <Crop
              data-testid='reference-mention-focus-badge'
              className='h-2.5 w-2.5 shrink-0'
              aria-hidden='true'
            />
            {/* SR counterpart (adversarial 2026-07-17): a crop shares its
                source node's name — announce the distinction. */}
            <span className='sr-only'>
              {t('canvas.generatePanel.focusCropTag')}
            </span>
          </>
        ) : null}
        <span className='truncate pr-1.5'>{label}</span>
      </NodeViewWrapper>
    </ThumbnailHoverPreview>
  );
}

/**
 * The reference-mention custom node: an inline, atomic, DRAGGABLE node
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
  // Draggable so a selected chip (or a chip-only selection) can be moved by
  // mouse (item ⑥). With `false`, tiptap's NodeView.stopEvent preventDefault()s
  // EVERY drag event on the chip and swallows it from ProseMirror — the drag
  // never starts in any browser. `true` makes PM keep a standing
  // draggable=true on the outer wrapper and lets the drag through, provided
  // the mousedown hit the [data-drag-handle] (the whole chip, see the
  // NodeViewWrapper). Dropping is a plain PM move transaction, so the
  // whitespace invariant (appendTransaction) heals both ends and yUndo
  // reverts it as one step.
  draggable: true,

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
    const getPool = this.options.getPool;
    return [
      Suggestion<ReferenceRailItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
      createReferenceMentionCaret(),
      // Highlight chips caught inside a text range selection (I2, user
      // 2026-07-12): a select-none atom is skipped by the browser's native
      // selection paint, so without this a selected chip reads as un-selected.
      createReferenceMentionRangeHighlight(),
      // Strip chips referencing a source this node isn't wired to when pasting
      // across nodes (E, user 2026-07-12): the words survive, the invalid chip
      // does not — a chip must be in the reference pool (same invariant the
      // cascade-clear effect enforces for edge removals).
      new Plugin({
        props: {
          transformPasted: (slice): Slice =>
            stripForeignReferenceChips(
              slice,
              new Set((getPool?.() ?? []).map((r) => r.sourceNodeId)),
            ),
        },
      }),
    ];
  },
});
