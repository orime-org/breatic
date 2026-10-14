// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media in pasted or dropped content (inner#1351 + inner#1390 design §5.4,
 * which replaces inner#1127 A18).
 *
 * With image, video and audio blocks in the schema, BlockNote's parse rules
 * turn every `<img>`, `<video>`, `<audio>` and Markdown `![]()` in a paste
 * into a media block pointing wherever the source pointed
 * (`Image/block.ts:55-75`, `Video/block.ts:35-49`, `Audio/block.ts:53-67`).
 * A block in this body carries an address our storage registered, so each
 * pasted medium is judged by its own address: under our public prefix it
 * stays; an outside address the ingest Worker can fetch, or a `data:` or
 * `blob:` one the browser can read, becomes a pending block whose upload
 * brings it into storage; anything else is left out and the reader is told
 * how many were. A pending block copied from a body keeps its upload id.
 * While our prefix is not known yet, every medium with an address becomes
 * pending, and its upload sorts ours from outside once the prefix is in.
 *
 * `transformPasted` sees every paste and every drop from outside the editor;
 * a row dragged within the body never reaches it — `document-drag-move.ts`
 * takes that drop first. The slice it returns is what is synced, so an
 * outside address never reaches the shared document. The uploads start once
 * the paste is in: the next update that holds the pending blocks.
 *
 * A table cell takes only words, and ProseMirror fits a slice to the cell
 * it lands in while it reads the HTML, so the media would be gone before
 * `transformPasted` sees the slice. HTML landing in a cell is therefore read
 * into blocks first (`transformPastedHTML`, which a paste, a drop and a
 * Markdown paste all pass through); its media come out and are judged as
 * above, and the rest goes on to the cell the way it would have without them.
 * The media land under the table in the same dispatch, appended to the
 * transaction that put the rest in, so one undo takes both (design §5.4, A7).
 */

import { blockToNode, createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { routeAddress } from '@web/spaces/document/document-canvas-paste';
import {
  inTableCell,
  pasteTarget,
  quotedAs,
  quotedBeside,
  type BlockSpec,
} from '@web/spaces/document/document-file-input';
import { isMediaBlockType, pendingUploadId } from '@web/spaces/document/document-media-types';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';
import { markOwnUndoStep } from '@web/spaces/document/document-undo-step';

/** What the body needs to judge pasted media. */
export interface PastedMediaOptions {
  /** What every address of ours starts with, or null while it is not known. */
  readonly assetUrlPrefix: () => string | null;
  /** Told how many media a paste left out, when it left any out. */
  readonly onLeftOut: (count: number) => void;
  /**
   * Starts the upload behind a pending block a paste brought in. Left out —
   * a body with nowhere to upload to — a medium that would have to be
   * fetched is left out instead.
   */
  readonly start?: (uploadId: string, source: UploadSource) => void;
}

/** What becomes of one pasted medium. */
type Verdict = 'keep' | 'pend' | 'drop';

/** An upload a paste queued, started once its block is in. */
interface Queued {
  readonly uploadId: string;
  readonly url: string;
}

/**
 * What becomes of a pasted medium.
 * @param attrs - The medium's attributes or props.
 * @param prefix - Our prefix, or null.
 * @returns The verdict.
 */
function verdictOf(attrs: Readonly<Record<string, unknown>>, prefix: string | null): Verdict {
  if (pendingUploadId(attrs) !== null) return 'keep';
  const url = attrs['url'];
  if (typeof url !== 'string' || url === '') return 'drop';
  if (prefix !== null && url.startsWith(prefix)) return 'keep';
  return routeAddress(url) === 'skip' ? 'drop' : 'pend';
}

/**
 * A fragment with every outside medium made pending or taken out.
 *
 * A nested block group emptied by this goes too: a block container may have
 * no group, and an empty one is not allowed (`blockGroupChild+`). The rows
 * nested under a medium taken out stay, in its place.
 * @param fragment - The fragment.
 * @param prefix - Our prefix, or null.
 * @param queued - Collects the uploads the pending blocks wait for; null
 *   when nothing would start them, and a medium to fetch is taken out instead.
 * @returns The fragment and how many media were taken out.
 */
function judge(
  fragment: Fragment,
  prefix: string | null,
  queued: Queued[] | null,
): { fragment: Fragment; dropped: number } {
  let dropped = 0;
  let changed = false;
  const kept: PMNode[] = [];
  fragment.forEach((node) => {
    const own = node.type.name === 'blockContainer' ? node.firstChild : null;
    const judged = own !== null && isMediaBlockType(own.type.name) ? verdictOf(own.attrs, prefix) : null;
    const verdict = judged === 'pend' && queued === null ? 'drop' : judged;
    if (verdict === 'drop') {
      changed = true;
      dropped += 1;
      // The rows nested under it are text the reader pasted: they take its place.
      const group = node.lastChild;
      if (group?.type.name === 'blockGroup') {
        const inner = judge(group.content, prefix, queued);
        dropped += inner.dropped;
        inner.fragment.forEach((child) => kept.push(child));
      }
      return;
    }
    if (node.isLeaf || node.isTextblock) {
      kept.push(node);
      return;
    }
    const inner = judge(node.content, prefix, queued);
    dropped += inner.dropped;
    let content = inner.fragment;
    if (verdict === 'pend') {
      const uploadId = crypto.randomUUID();
      queued!.push({ uploadId, url: own!.attrs['url'] as string });
      content = content.replaceChild(0, own!.type.create({ ...own!.attrs, url: '', uploadId }, own!.content, own!.marks));
    }
    if (content === node.content) {
      kept.push(node);
    } else if (node.type.name !== 'blockGroup' || content.childCount > 0) {
      changed = true;
      kept.push(node.copy(content));
    }
  });
  return { fragment: changed ? Fragment.from(kept) : fragment, dropped };
}

/**
 * Upload ids of the pending media blocks in a document.
 * @param doc - The document.
 * @returns The ids.
 */
function pendingIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const uploadId = isMediaBlockType(node.type.name) ? pendingUploadId(node.attrs) : null;
    if (uploadId !== null) ids.add(uploadId);
    return true;
  });
  return ids;
}

/** A block as BlockNote reads it out of HTML. */
interface ReadBlock {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly ReadBlock[];
}

/**
 * Blocks with every medium taken out, in document order; the rows nested
 * under a medium stay, in its place.
 * @param blocks - The blocks.
 * @param taken - Collects the media, without their nested rows.
 * @returns The blocks without them.
 */
function mediaOut(blocks: readonly ReadBlock[], taken: ReadBlock[]): ReadBlock[] {
  return blocks.flatMap((block) => {
    if (isMediaBlockType(block.type)) {
      taken.push(block);
      return mediaOut(block.children, taken);
    }
    return [{ ...block, children: mediaOut(block.children, taken) }];
  });
}

/** HTML landing in a table cell, with its media taken out and judged. */
interface CellLanding {
  /** Where it lands. */
  readonly at: number;
  /** The media, judged, to go under the table. */
  readonly media: readonly BlockSpec[];
  /** The uploads the pending ones among them wait for. */
  readonly queued: readonly Queued[];
  /** Whether nothing but media was in it. */
  readonly onlyMedia: boolean;
}

/**
 * Puts a cell landing's media under the table its place is in, as an undo
 * step of its own.
 * @param state - The state the media go into.
 * @param at - Where the landing is, in that state's document.
 * @param media - The media.
 * @returns The transaction.
 */
function mediaUnderTable(state: EditorState, at: number, media: readonly BlockSpec[]): Transaction {
  const gap = pasteTarget(state, state.doc.resolve(at)).gap;
  const nodes = quotedAs(media, quotedBeside(state.doc, gap, false)).map((block) =>
    blockToNode({ id: crypto.randomUUID(), ...block } as never, state.schema),
  );
  return markOwnUndoStep(state.tr.insert(gap, Fragment.from(nodes)));
}

/**
 * The extension that judges pasted media.
 * @param options - Our prefix, where the count goes and where uploads start;
 *   left out, every pasted medium with an address is left out and nobody is
 *   told.
 * @returns The extension, for the assembly to register.
 */
export function documentPastedMediaExtension(
  options: PastedMediaOptions | undefined,
): ExtensionFactoryInstance {
  return createExtension(({ editor }) => {
    let queued: Queued[] = [];
    let dropAt: number | null = null;
    let landing: CellLanding | null = null;

    /**
     * Takes the media out of HTML landing in a table cell and judges them.
     * @param html - The HTML.
     * @param at - Where it lands.
     * @returns The HTML that goes on to the cell.
     */
    const readForCell = (html: string, at: number): string => {
      const taken: ReadBlock[] = [];
      const rest = mediaOut(editor.tryParseHTMLToBlocks(html) as unknown as ReadBlock[], taken);
      if (taken.length === 0) return html;
      const prefix = options?.assetUrlPrefix() ?? null;
      const media: BlockSpec[] = [];
      const waiting: Queued[] = [];
      let dropped = 0;
      for (const { type, props } of taken) {
        const verdict = verdictOf(props, prefix);
        if (verdict === 'keep') {
          media.push({ type, props });
        } else if (verdict === 'pend' && options?.start !== undefined) {
          const uploadId = crypto.randomUUID();
          waiting.push({ uploadId, url: props['url'] as string });
          media.push({ type, props: { ...props, url: '', uploadId } });
        } else {
          dropped += 1;
        }
      }
      if (dropped > 0) options?.onLeftOut(dropped);
      const held: CellLanding = { at, media, queued: waiting, onlyMedia: rest.length === 0 };
      landing = held;
      // A paste or a drop is put in within the event that read it.
      queueMicrotask(() => {
        if (landing === held) landing = null;
      });
      return rest.length === 0 ? '' : editor.blocksToFullHTML(rest as never);
    };

    /**
     * Takes the landing whose HTML was read, starting its uploads' wait.
     * @returns The landing, or null when none is held.
     */
    const take = (): CellLanding | null => {
      const held = landing;
      landing = null;
      if (held !== null) queued = [...queued, ...held.queued];
      return held;
    };

    /**
     * Puts in a landing that held nothing but media: there is no rest for
     * the paste or the drop to put in, so the media go in by themselves.
     * @param view - The editor view.
     * @returns True when it was such a landing.
     */
    const landOnlyMedia = (view: EditorView): boolean => {
      if (landing?.onlyMedia !== true) return false;
      const held = take()!;
      view.dispatch(mediaUnderTable(view.state, held.at, held.media).scrollIntoView());
      return true;
    };

    return {
      key: 'documentPastedMedia',
      prosemirrorPlugins: [
        new Plugin({
          props: {
            handleDOMEvents: {
              // Where an outside drop lands, for the HTML it carries.
              drop: (view, event) => {
                dropAt = view.dragging === null ? (view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null) : null;
                queueMicrotask(() => {
                  dropAt = null;
                });
                return false;
              },
            },
            transformPastedHTML: (html, view) => {
              const at = dropAt ?? view.state.selection.from;
              dropAt = null;
              landing = null;
              return inTableCell(view.state.doc.resolve(at)) ? readForCell(html, at) : html;
            },
            transformPasted: (slice) => {
              const found: Queued[] = [];
              const prefix = options?.assetUrlPrefix() ?? null;
              const { fragment, dropped } = judge(slice.content, prefix, options?.start === undefined ? null : found);
              queued = [...queued, ...found];
              if (dropped > 0) options?.onLeftOut(dropped);
              if (fragment === slice.content) return slice;
              return fragment.childCount === 0 ? Slice.empty : Slice.maxOpen(fragment);
            },
            handlePaste: (view) => landOnlyMedia(view),
            handleDrop: (view, _event, _slice, moved) => !moved && landOnlyMedia(view),
          },
          // The rest went in the way it would have without the media; the
          // media follow in the same dispatch.
          appendTransaction: (transactions, _old, state) => {
            if (landing === null || !transactions.some((tr) => tr.docChanged)) return null;
            const held = take()!;
            // Mapped to the left of what went in there, so it stays in the
            // cell the reader pasted into, under the table they aimed at.
            const at = transactions.reduce((pos, tr) => tr.mapping.map(pos, -1), held.at);
            return mediaUnderTable(state, at, held.media);
          },
          view: () => ({
            update: (view) => {
              if (queued.length === 0) return;
              // A drop updates the view (it focuses it) before it dispatches
              // the slice, so a queued upload waits for its block to arrive.
              const present = pendingIds(view.state.doc);
              const ready = queued.filter(({ uploadId }) => present.has(uploadId));
              queued = queued.filter(({ uploadId }) => !present.has(uploadId));
              for (const { uploadId, url } of ready) options?.start?.(uploadId, { kind: 'address', url });
            },
          }),
        }),
      ],
    };
  })();
}

/** Whether a piece of HTML carries an image, a video or an audio. */
export const HTML_MEDIA = /<(img|video|audio)\b/i;
