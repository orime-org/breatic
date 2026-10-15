// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media in pasted or dropped content (inner#1351 + inner#1390 design §5.4,
 * which replaces inner#1127 A18).
 *
 * Pasted HTML is made ready to read first (`document-paste-html.ts`): its
 * media stand where a block can, and BlockNote's parse rules read each into
 * a media block pointing wherever the source pointed (`Image/block.ts:55-75`,
 * `Video/block.ts:35-49`, `Audio/block.ts:53-67`); a medium a read still
 * loses is counted as left out. A block in this body carries an address our
 * storage registered, so each
 * pasted medium is judged by its own address: under our public prefix it
 * stays; an outside address the ingest Worker can fetch, or a `data:` or
 * `blob:` one the browser can read, becomes a pending block whose upload
 * brings it into storage; anything else is left out and the reader is told
 * how many were. A pending block copied from a body keeps its upload id.
 * While our prefix is not known yet, every medium whose address can reach
 * storage becomes pending, and its upload sorts ours from outside once the
 * prefix is in.
 *
 * Blocks an Agent proposal writes keep only media of ours (inner#1509),
 * through {@link ownMediaOnly}.
 *
 * `transformPasted` sees every paste and every drop; a row moved or copied
 * within the body is already in the shared document and is passed over. The
 * slice it returns is what is synced, so an outside address never reaches
 * the shared document. The uploads start once the paste or the drop is done:
 * a pending block that went in starts its upload, and one another hook kept
 * out (a link pasted over a selection takes the whole paste) is counted as
 * left out.
 *
 * A table cell takes only words, and ProseMirror fits a slice to the cell it
 * lands in while it reads the HTML, so the media would be gone before
 * `transformPasted` sees the slice. HTML landing in a cell — a paste, a drop
 * and a Markdown paste all pass through `transformPastedHTML` — has its media
 * read out and judged as above, and the rest goes on as it was without them.
 * The media land under that table in the dispatch that puts the rest in, or
 * by themselves once the event is done when no dispatch changed the document
 * (design §5.4, A7). A drop whose words a cell cannot take — they hold a
 * table — lands whole under the table it was dropped on, in its order.
 *
 * Outside HTML a drop carries with media is read the way a paste of it is
 * (`documentPasteHandler`): made ready, read into blocks by BlockNote and
 * written out again, so its blocks nest the way BlockNote nests them.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';

import { newId } from '@breatic/shared';

import { assetsApi } from '@web/data/api/assets';
import { addressLanding } from '@web/spaces/document/document-media-address';
import {
  inTableCell,
  insertAtGapTr,
  pasteTarget,
  type BlockSpec,
} from '@web/spaces/document/document-file-input';
import { isMediaBlockType, pendingUploadId } from '@web/spaces/document/document-media-types';
import {
  HTML_MEDIA,
  PASTED_MEDIA_KEY,
  holdsTable,
  mediaIn,
  preparePastedHTML,
  withoutMedia,
  type ReadBlock,
} from '@web/spaces/document/document-paste-html';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';
import { markOwnUndoStep } from '@web/spaces/document/document-undo-step';

/**
 * What every address of ours starts with, or null while it is not known.
 * @returns The prefix.
 */
export function ourMediaPrefix(): string | null {
  return assetsApi.cachedUploadConfig()?.assetUrlPrefix ?? null;
}

/**
 * What every address of ours starts with, waiting for it when this session
 * has not fetched it yet. Readers that can wait use this one; a paste cannot,
 * and reads {@link ourMediaPrefix}.
 * @returns The prefix, or null when it could not be fetched.
 */
export async function ourMediaPrefixReady(): Promise<string | null> {
  return assetsApi.fetchUploadConfig().then(
    (config) => config.assetUrlPrefix,
    () => null,
  );
}

/** A block about to be written, as BlockNote's parser hands it back. */
export interface WrittenBlock {
  type?: string;
  props?: Record<string, unknown>;
  children?: WrittenBlock[];
}

/**
 * Blocks with every medium that is not ours taken out, and how many were:
 * the rule Agent proposals follow (inner#1509). The rows nested under a
 * medium taken out stay, in its place.
 * @param blocks - The blocks.
 * @param prefix - Our prefix, or null.
 * @returns The blocks kept and the count.
 */
export function ownMediaOnly(blocks: readonly WrittenBlock[], prefix: string | null): { blocks: WrittenBlock[]; count: number } {
  let count = 0;
  const kept: WrittenBlock[] = [];
  for (const block of blocks) {
    const inner = ownMediaOnly(block.children ?? [], prefix);
    count += inner.count;
    const url = block.props?.['url'];
    const ours = typeof url === 'string' && addressLanding(url, prefix, false) === 'ours';
    if (block.type !== undefined && isMediaBlockType(block.type) && !ours) {
      count += 1;
      kept.push(...inner.blocks);
      continue;
    }
    kept.push(block.children === undefined ? block : { ...block, children: inner.blocks });
  }
  return { blocks: kept, count };
}

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

/** An upload a paste waits on, started once its block is in. */
interface Queued {
  readonly uploadId: string;
  readonly url: string;
}

/**
 * What a pasted medium becomes: its attributes as they are, a pending
 * block's with its upload queued, or null when it is left out.
 * @param attrs - The medium's attributes or props.
 * @param prefix - Our prefix, or null.
 * @param queue - Collects the uploads pending blocks wait for; null when
 *   nothing would start them, and a medium to fetch is left out instead.
 * @returns The attributes it lands with, or null.
 */
function pended(
  attrs: Readonly<Record<string, unknown>>,
  prefix: string | null,
  queue: Queued[] | null,
): Readonly<Record<string, unknown>> | null {
  if (pendingUploadId(attrs) !== null) return attrs;
  const url = attrs['url'];
  if (typeof url !== 'string') return null;
  const how = addressLanding(url, prefix, queue !== null);
  if (how === null) return null;
  // Ours stays as it is; a medium to upload lands only with a queue.
  if (how === 'ours' || queue === null) return attrs;
  const uploadId = newId();
  queue.push({ uploadId, url });
  return { ...attrs, url: '', uploadId };
}

/**
 * A fragment with every outside medium made pending or taken out.
 *
 * A nested block group emptied by this goes too: a block container may have
 * no group, and an empty one is not allowed (`blockGroupChild+`). The rows
 * nested under a medium taken out stay, in its place.
 * @param fragment - The fragment.
 * @param prefix - Our prefix, or null.
 * @param queue - Collects the uploads the pending blocks wait for, or null.
 * @returns The fragment and how many media were taken out.
 */
function judge(
  fragment: Fragment,
  prefix: string | null,
  queue: Queued[] | null,
): { fragment: Fragment; dropped: number } {
  let dropped = 0;
  let changed = false;
  const kept: PMNode[] = [];
  fragment.forEach((node) => {
    const own = node.type.name === 'blockContainer' ? node.firstChild : null;
    const medium = own !== null && isMediaBlockType(own.type.name) ? own : null;
    const attrs = medium === null ? null : pended(medium.attrs, prefix, queue);
    if (medium !== null && attrs === null) {
      changed = true;
      dropped += 1;
      // The rows nested under it are text the reader pasted: they take its place.
      const group = node.lastChild;
      if (group?.type.name === 'blockGroup') {
        const inner = judge(group.content, prefix, queue);
        dropped += inner.dropped;
        inner.fragment.forEach((child) => kept.push(child));
      }
      return;
    }
    if (node.isLeaf || node.isTextblock) {
      kept.push(node);
      return;
    }
    const inner = judge(node.content, prefix, queue);
    dropped += inner.dropped;
    let content = inner.fragment;
    if (medium !== null && attrs !== medium.attrs) {
      content = content.replaceChild(0, medium.type.create(attrs, medium.content, medium.marks));
    }
    if (content === node.content) {
      kept.push(node);
      return;
    }
    changed = true;
    if (node.type.name !== 'blockGroup' || content.childCount > 0) kept.push(node.copy(content));
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

/**
 * Whether a block holds no text to join a line: a medium, a table.
 * @param node - The block, or null.
 * @returns True for a block container whose own content is not a text block.
 */
function opensOnBlock(node: PMNode | null): boolean {
  const own = node?.type.name === 'blockContainer' ? node.firstChild : null;
  return own !== null && !own.isTextblock;
}

/**
 * A slice opening on a block with no text to join the line, closed there, so
 * that block lands beside the line it is put into and the line splits around
 * it, as a file or a canvas paste puts one. A slice read out of HTML holds
 * its blocks in one open group, which ProseMirror fits into the line as that
 * line's nested group when the group opens on such a block; the blocks come
 * out of it first. A slice opening on text joins the line and is left as it
 * is.
 * @param slice - The slice.
 * @returns It, or its blocks with the start closed.
 */
function closedAtBlock(slice: Slice): Slice {
  let { content, openStart, openEnd } = slice;
  while (content.childCount === 1 && content.firstChild!.type.name === 'blockGroup' && openStart > 0 && openEnd > 0) {
    content = content.firstChild!.content;
    openStart -= 1;
    openEnd -= 1;
  }
  return opensOnBlock(content.firstChild) ? new Slice(content, 0, openEnd) : slice;
}

/**
 * Where the line a slice opening on a block lands at the start of begins,
 * when that line holds words: ProseMirror splits the line there and leaves
 * its empty first half above the block.
 * @param doc - The document before the slice lands.
 * @param at - Where it lands.
 * @param slice - The slice, as it lands.
 * @returns The line's start, or null.
 */
function lineStartUnder(doc: PMNode, at: number, slice: Slice): number | null {
  const $at = doc.resolve(at);
  if (slice.openStart !== 0 || !opensOnBlock(slice.content.firstChild)) return null;
  if ($at.parentOffset !== 0 || !$at.parent.isTextblock || $at.parent.content.size === 0 || $at.depth === 0) return null;
  return $at.node($at.depth - 1).type.name === 'blockContainer' ? $at.before($at.depth - 1) : null;
}

/**
 * Whether a block is a line with nothing in it and no lines nested under it.
 * @param node - The block, or null.
 * @returns True for an empty line.
 */
function isEmptyLine(node: PMNode | null): node is PMNode {
  return node?.type.name === 'blockContainer' && node.childCount === 1 && node.firstChild!.isTextblock && node.firstChild!.content.size === 0;
}

/** HTML BlockNote wrote, as a paste hands it on after reading. */
const BLOCKNOTE_HTML = /data-node-type="blockContainer"/;

/** HTML landing in a table cell, its media taken out and judged. */
interface CellLanding {
  /** Where it lands. */
  readonly at: number;
  /** The media, judged, to go under the table. */
  readonly media: readonly BlockSpec[];
  /** The uploads the pending ones among them wait for. */
  readonly queued: readonly Queued[];
}

/**
 * A transaction putting a cell landing's media under the table its place is in.
 * @param state - The state they go into.
 * @param at - Where the landing is, in that state's document.
 * @param media - The media.
 * @returns The transaction.
 */
function mediaUnderTable(state: EditorState, at: number, media: readonly BlockSpec[]): Transaction {
  return insertAtGapTr(state, pasteTarget(state, state.doc.resolve(at)).gap, false, media);
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
    let leftOut = 0;
    let flushing = false;
    let dropAt: number | null = null;
    // Media in outside HTML about to be read; null for HTML BlockNote wrote,
    // which a paste's own read already counted.
    let expected: number | null = null;
    let landing: CellLanding | null = null;
    // Where the HTML being read lands, for its slice.
    let into: number | null = null;
    // The start of the line a block lands at the start of, to take the empty
    // half the split leaves off in the same dispatch.
    let edge: number | null = null;
    // A drop of outside HTML read the way a paste of it is: where it was
    // dropped, and the gap under the table when a cell cannot take its words.
    let heldDrop: { at: number; under: number | null } | null = null;

    /**
     * Once the paste or the drop is done, starts the uploads whose blocks
     * went in and tells how many media were left out, once: those judged out
     * and those another hook kept out — a hook can take a paste and put in
     * none of it.
     */
    const settle = (): void => {
      if (flushing) return;
      flushing = true;
      queueMicrotask(() => {
        flushing = false;
        const doc = editor.prosemirrorView?.state.doc;
        const present = doc === undefined ? new Set<string>() : pendingIds(doc);
        const waiting = queued;
        const judgedOut = leftOut;
        queued = [];
        leftOut = 0;
        const missing = waiting.filter(({ uploadId }) => !present.has(uploadId)).length;
        for (const { uploadId, url } of waiting) {
          if (present.has(uploadId)) options?.start?.(uploadId, { kind: 'address', url });
        }
        if (judgedOut + missing > 0) options?.onLeftOut(judgedOut + missing);
      });
    };

    /**
     * Whether a pasted medium at this address lands in the body.
     * @param url - The address.
     * @returns True when it lands.
     */
    const lands = (url: string): boolean =>
      addressLanding(url, options?.assetUrlPrefix() ?? null, options?.start !== undefined) !== null;

    /**
     * Counts media judged out or lost in a read, told once the event is done.
     * @param count - How many.
     */
    const leaveOut = (count: number): void => {
      if (count <= 0) return;
      leftOut += count;
      settle();
    };

    /** Takes the landing whose HTML was read; its uploads join the queue. */
    const take = (): void => {
      const held = landing;
      landing = null;
      if (held === null) return;
      queued = [...queued, ...held.queued];
      settle();
    };

    /**
     * Takes the media out of HTML landing in a table cell and judges them.
     * The words go on the way they would have without them, their lines as
     * they were; the media follow in the dispatch that puts the words in, or
     * by themselves once the event is done when that dispatch changes nothing.
     * @param html - The HTML ready to read, its media where a block stands.
     * @param words - The HTML as it came, for the words.
     * @param at - Where it lands.
     * @param view - The editor view.
     * @returns The HTML that goes on to the cell.
     */
    const readForCell = (html: string, words: string, at: number, view: EditorView): string => {
      const found = mediaIn(editor.tryParseHTMLToBlocks(html) as unknown as ReadBlock[]);
      leaveOut((expected ?? found.length) - found.length);
      expected = null;
      if (found.length === 0) return words;
      const prefix = options?.assetUrlPrefix() ?? null;
      const waiting: Queued[] = [];
      const media: BlockSpec[] = [];
      for (const { type, props } of found) {
        const attrs = pended(props, prefix, options?.start === undefined ? null : waiting);
        if (attrs !== null) media.push({ type, props: attrs });
      }
      leaveOut(found.length - media.length);
      if (media.length > 0) {
        const held: CellLanding = { at, media, queued: waiting };
        landing = held;
        queueMicrotask(() => {
          if (landing !== held) return;
          take();
          view.dispatch(markOwnUndoStep(mediaUnderTable(view.state, held.at, held.media)).scrollIntoView());
        });
      }
      return withoutMedia(words);
    };

    return {
      key: PASTED_MEDIA_KEY,
      leaveOut,
      lands,
      prosemirrorPlugins: [
        new Plugin({
          props: {
            // A drop read the way a paste is lands under the table when a cell
            // cannot take its words, and under the line it was dropped on when
            // ProseMirror finds no place for it there.
            handleDrop: (view, _event, slice, moved) => {
              const held = heldDrop;
              heldDrop = null;
              if (held === null || moved) return false;
              const gap =
                held.under ?? (dropPoint(view.state.doc, held.at, slice) === null ? pasteTarget(view.state, view.state.doc.resolve(held.at)).gap : null);
              if (gap === null) return false;
              view.focus();
              view.dispatch(view.state.tr.replaceRange(gap, gap, slice).setMeta('uiEvent', 'drop').scrollIntoView());
              return true;
            },
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
            transformPastedHTML: (pasted, view) => {
              // A drop's HTML reaches the read here; a paste's was made
              // ready and counted before BlockNote wrote it out again.
              const own = BLOCKNOTE_HTML.test(pasted);
              const { html, media } = own ? { html: pasted, media: 0 } : preparePastedHTML(pasted, lands);
              expected = own ? null : media;
              const isDrop = dropAt !== null;
              const at = dropAt ?? view.state.selection.from;
              dropAt = null;
              landing = null;
              heldDrop = null;
              into = at;
              const read = own || !HTML_MEDIA.test(html) ? null : (editor.tryParseHTMLToBlocks(html) as unknown as ReadBlock[]);
              const inCell = inTableCell(view.state.doc.resolve(at));
              if (inCell && (read === null || !holdsTable(read))) return readForCell(html, pasted, at, view);
              if (read === null) return html;
              if (isDrop) heldDrop = { at, under: inCell ? pasteTarget(view.state, view.state.doc.resolve(at)).gap : null };
              return editor.blocksToFullHTML(read as never);
            },
            transformPasted: (slice, view) => {
              // A row moved or copied within the body is already ours.
              if (view.dragging !== null) return slice;
              // A slice landing in a table is fitted by the table's own paste
              // (cells over cells), which reads it as it came.
              const at = into;
              into = null;
              const fit = at !== null && inTableCell(view.state.doc.resolve(at)) ? (read: Slice): Slice => read : closedAtBlock;
              if (expected !== null) {
                let read = 0;
                slice.content.descendants((node) => {
                  if (isMediaBlockType(node.type.name)) read += 1;
                  return true;
                });
                leaveOut(expected - read);
                expected = null;
              }
              const found: Queued[] = [];
              const prefix = options?.assetUrlPrefix() ?? null;
              const { fragment, dropped } = judge(slice.content, prefix, options?.start === undefined ? null : found);
              queued = [...queued, ...found];
              if (found.length > 0) settle();
              leaveOut(dropped);
              // Opened as ProseMirror opens HTML it reads, up to an isolating
              // node, so a table's last cell does not take the line's tail.
              const landed =
                fragment === slice.content ? fit(slice) : fragment.childCount === 0 ? Slice.empty : fit(Slice.maxOpen(fragment, false));
              edge = at === null ? null : lineStartUnder(view.state.doc, at, landed);
              return landed;
            },
          },
          // The rest went in the way it would have without the media; the
          // media follow in the same dispatch, mapped to the left of what went
          // in, so they stay under the table the reader aimed at.
          // A block pasted or dropped at the start of a line with words takes
          // the empty half the split leaves above it off, in the same dispatch.
          appendTransaction: (transactions, _old, state) => {
            if (!transactions.some((tr) => tr.docChanged)) return null;
            const held = landing;
            if (held !== null) {
              take();
              const at = transactions.reduce((pos, tr) => tr.mapping.map(pos, -1), held.at);
              return mediaUnderTable(state, at, held.media);
            }
            const start = edge;
            edge = null;
            if (start === null || !transactions.some((tr) => ['paste', 'drop'].includes(tr.getMeta('uiEvent') as string))) return null;
            const at = transactions.reduce((pos, tr) => tr.mapping.map(pos, -1), start);
            const left = state.doc.nodeAt(at);
            return isEmptyLine(left) ? state.tr.delete(at, at + left.nodeSize) : null;
          },
        }),
      ],
    };
  })();
}
