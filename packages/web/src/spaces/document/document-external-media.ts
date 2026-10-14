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
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { routeAddress } from '@web/spaces/document/document-canvas-paste';
import {
  insertAtGap,
  pasteTarget,
  type BlockSpec,
  type PasteHandler,
} from '@web/spaces/document/document-file-input';
import { isMediaBlockType, type MediaBlockType } from '@web/spaces/document/document-media-types';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';
import { pendingBlock } from '@web/spaces/document/document-uploads';

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
 * What becomes of a pasted block's medium, or null when it holds none.
 * @param own - The block's own node, the container's first child.
 * @param prefix - Our prefix, or null.
 * @returns The verdict.
 */
function verdictOf(own: PMNode, prefix: string | null): Verdict {
  const uploadId = own.attrs['uploadId'];
  if (typeof uploadId === 'string' && uploadId !== '') return 'keep';
  const url = own.attrs['url'];
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
    const judged = own !== null && isMediaBlockType(own.type.name) ? verdictOf(own, prefix) : null;
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
    const uploadId = node.attrs['uploadId'];
    if (isMediaBlockType(node.type.name) && typeof uploadId === 'string' && uploadId !== '' && node.attrs['url'] === '') {
      ids.add(uploadId);
    }
    return true;
  });
  return ids;
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
  return createExtension(() => {
    let queued: Queued[] = [];
    return {
      key: 'documentPastedMedia',
      prosemirrorPlugins: [
        new Plugin({
          props: {
            transformPasted: (slice) => {
              const found: Queued[] = [];
              const prefix = options?.assetUrlPrefix() ?? null;
              const { fragment, dropped } = judge(slice.content, prefix, options?.start === undefined ? null : found);
              queued = found;
              if (dropped > 0) options?.onLeftOut(dropped);
              if (fragment === slice.content) return slice;
              return fragment.childCount === 0 ? Slice.empty : Slice.maxOpen(fragment);
            },
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

/** The block type each media element becomes. */
const TYPE_OF_TAG: Readonly<Record<string, MediaBlockType>> = { IMG: 'image', VIDEO: 'video', AUDIO: 'audio' };

/** A medium taken out of pasted HTML. */
interface TakenMedium {
  readonly type: MediaBlockType;
  readonly url: string;
  readonly name: string;
  readonly caption: string;
}

/**
 * Takes every image, video and audio out of a parsed piece of HTML, with the
 * figure around it, reading its address, its `alt` as the name and the
 * figure's caption the way BlockNote's parse rules read them.
 * @param body - The parsed HTML's body; the media are removed from it.
 * @returns The media, in document order.
 */
function takeMedia(body: HTMLElement): TakenMedium[] {
  return Array.from(body.querySelectorAll('img, video, audio')).map((element) => {
    const figure = element.closest('figure');
    const url = element.getAttribute('src') ?? element.querySelector('source')?.getAttribute('src') ?? '';
    const caption = figure?.querySelector('figcaption')?.textContent?.trim() ?? '';
    (figure ?? element).remove();
    return {
      type: TYPE_OF_TAG[element.tagName]!,
      url,
      name: element.getAttribute('alt') ?? '',
      caption,
    };
  });
}

/**
 * Whether the selection is inside a table cell.
 * @param view - The editor view.
 * @returns True when an ancestor of the selection's head is a cell.
 */
function inTableCell(view: EditorView): boolean {
  const { $head } = view.state.selection;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const name = $head.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

/**
 * The paste of web content with the caret in a table cell (design §5.4).
 *
 * A table cell takes only words, so the default paste would flatten the HTML
 * into the cell and every medium would be gone. Here the media come out
 * first: the rest goes to the default paste, into the cell, and the media
 * land under the table right after it, in the same undo step (nothing closes
 * the step between the two dispatches).
 * @param options - Our prefix, where the count goes and where uploads start.
 * @param next - The paste every other clipboard goes to.
 * @returns The hook.
 */
export function cellMediaPasteHandler(options: PastedMediaOptions, next: PasteHandler): PasteHandler {
  return (context) => {
    const { event } = context;
    const view = context.editor.prosemirrorView;
    const data = event.clipboardData;
    const html = data?.getData('text/html') ?? '';
    if (view === undefined || view === null || data === null || !HTML_MEDIA.test(html) || !inTableCell(view)) {
      return next(context);
    }
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const taken = takeMedia(parsed.body);
    const rest = parsed.body.innerHTML;
    const without: Pick<DataTransfer, 'types' | 'files' | 'items' | 'getData'> = {
      types: data.types,
      files: data.files,
      items: data.items,
      getData: (format: string): string => (format === 'text/html' ? rest : data.getData(format)),
    };
    Object.defineProperty(event, 'clipboardData', { value: without });
    const handled = next(context);

    const prefix = options.assetUrlPrefix();
    const blocks: BlockSpec[] = [];
    const started: { uploadId: string; url: string }[] = [];
    let dropped = 0;
    for (const medium of taken) {
      if (prefix !== null && medium.url.startsWith(prefix)) {
        blocks.push({ type: medium.type, props: { url: medium.url, name: medium.name, caption: medium.caption } });
      } else if (medium.url === '' || routeAddress(medium.url) === 'skip' || options.start === undefined) {
        dropped += 1;
      } else {
        const uploadId = crypto.randomUUID();
        started.push({ uploadId, url: medium.url });
        blocks.push(pendingBlock(medium.type, uploadId, medium.name, medium.caption));
      }
    }
    if (blocks.length > 0) insertAtGap(view, pasteTarget(view.state).gap, false, blocks);
    for (const { uploadId, url } of started) options.start?.(uploadId, { kind: 'address', url });
    if (dropped > 0) options.onLeftOut(dropped);
    return handled;
  };
}
