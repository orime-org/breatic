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
 * (design §5.4, A7).
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { routeAddress } from '@web/spaces/document/document-canvas-paste';
import {
  inTableCell,
  insertAtGapTr,
  pasteTarget,
  type BlockSpec,
} from '@web/spaces/document/document-file-input';
import { MEDIA_BLOCK_TYPES, isMediaBlockType, pendingUploadId } from '@web/spaces/document/document-media-types';
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
  if (typeof url !== 'string' || url === '') return null;
  if (prefix !== null && url.startsWith(prefix)) return attrs;
  if (queue === null || routeAddress(url) === 'skip') return null;
  const uploadId = crypto.randomUUID();
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
interface ReadBlock extends BlockSpec {
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly ReadBlock[];
}

/**
 * Every medium among blocks, nested ones too, in document order.
 * @param blocks - The blocks.
 * @returns The media.
 */
function mediaIn(blocks: readonly ReadBlock[]): ReadBlock[] {
  return blocks.flatMap((block) => [...(isMediaBlockType(block.type) ? [block] : []), ...mediaIn(block.children)]);
}

/** BlockNote's own HTML for a media block, as its export writes it. */
const OWN_MEDIA = MEDIA_BLOCK_TYPES.map((type) => `[data-content-type="${type}"]`).join(', ');

/**
 * Pasted HTML with its media taken out and the rest as it was, so the rest
 * lands the way it would have without them. A media block of BlockNote's own
 * HTML goes with its row, the rows nested under it taking its place; an
 * outside picture, video or audio goes with the figure around it.
 * @param html - The HTML.
 * @returns The HTML without its media; an empty paragraph when nothing else
 *   was in it, since no HTML at all would have the plain text read instead.
 */
function withoutMedia(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  for (const content of Array.from(body.querySelectorAll(OWN_MEDIA))) {
    const row = content.closest('[data-node-type="blockOuter"]') ?? content;
    const nested = row.querySelector(':scope > [data-node-type="blockContainer"] > [data-node-type="blockGroup"]');
    row.replaceWith(...Array.from(nested?.children ?? []));
  }
  for (const element of Array.from(body.querySelectorAll('img, video, audio'))) {
    (element.closest('figure') ?? element).remove();
  }
  return body.innerHTML.trim() === '' ? '<p></p>' : body.innerHTML;
}

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
    let flushing = false;
    let dropAt: number | null = null;
    let landing: CellLanding | null = null;

    /**
     * Once the paste or the drop is done, starts the uploads whose blocks
     * went in and counts the rest as left out: another hook can take a paste
     * and put in none of it.
     * @param view - The editor view.
     */
    const settle = (view: EditorView): void => {
      if (flushing) return;
      flushing = true;
      queueMicrotask(() => {
        flushing = false;
        const present = pendingIds(view.state.doc);
        const waiting = queued;
        queued = [];
        const missing = waiting.filter(({ uploadId }) => !present.has(uploadId)).length;
        for (const { uploadId, url } of waiting) {
          if (present.has(uploadId)) options?.start?.(uploadId, { kind: 'address', url });
        }
        if (missing > 0) options?.onLeftOut(missing);
      });
    };

    /**
     * Takes the landing whose HTML was read; its uploads join the queue.
     * @param view - The editor view.
     * @returns The landing, or null when none is held.
     */
    const take = (view: EditorView): CellLanding | null => {
      const held = landing;
      landing = null;
      if (held === null) return null;
      queued = [...queued, ...held.queued];
      settle(view);
      return held;
    };

    /**
     * Takes the media out of HTML landing in a table cell and judges them.
     * The rest goes on the way it would have without them; the media follow
     * in the dispatch that puts it in, or by themselves once the event is
     * done when that dispatch changes nothing.
     * @param html - The HTML.
     * @param at - Where it lands.
     * @param view - The editor view.
     * @returns The HTML that goes on to the cell.
     */
    const readForCell = (html: string, at: number, view: EditorView): string => {
      const found = mediaIn(editor.tryParseHTMLToBlocks(html) as unknown as ReadBlock[]);
      if (found.length === 0) return html;
      const prefix = options?.assetUrlPrefix() ?? null;
      const waiting: Queued[] = [];
      const media: BlockSpec[] = [];
      for (const { type, props } of found) {
        const attrs = pended(props, prefix, options?.start === undefined ? null : waiting);
        if (attrs !== null) media.push({ type, props: attrs });
      }
      if (media.length < found.length) options?.onLeftOut(found.length - media.length);
      if (media.length > 0) {
        const held: CellLanding = { at, media, queued: waiting };
        landing = held;
        queueMicrotask(() => {
          if (landing !== held) return;
          take(view);
          view.dispatch(markOwnUndoStep(mediaUnderTable(view.state, held.at, held.media)).scrollIntoView());
        });
      }
      return withoutMedia(html);
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
              return inTableCell(view.state.doc.resolve(at)) ? readForCell(html, at, view) : html;
            },
            transformPasted: (slice, view) => {
              // A row moved or copied within the body is already ours.
              if (view.dragging !== null) return slice;
              const found: Queued[] = [];
              const prefix = options?.assetUrlPrefix() ?? null;
              const { fragment, dropped } = judge(slice.content, prefix, options?.start === undefined ? null : found);
              queued = [...queued, ...found];
              if (found.length > 0) settle(view);
              if (dropped > 0) options?.onLeftOut(dropped);
              if (fragment === slice.content) return slice;
              return fragment.childCount === 0 ? Slice.empty : Slice.maxOpen(fragment);
            },
          },
          // The rest went in the way it would have without the media; the
          // media follow in the same dispatch, mapped to the left of what went
          // in, so they stay under the table the reader aimed at.
          appendTransaction: (transactions, _old, state) => {
            const held = landing;
            if (held === null || !transactions.some((tr) => tr.docChanged)) return null;
            const view = editor.prosemirrorView;
            if (view === undefined || view === null) return null;
            take(view);
            const at = transactions.reduce((pos, tr) => tr.mapping.map(pos, -1), held.at);
            return mediaUnderTable(state, at, held.media);
          },
        }),
      ],
    };
  })();
}
