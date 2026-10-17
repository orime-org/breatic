// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media in pasted or dropped content (inner#1351 + inner#1390 design §5.4,
 * which replaces inner#1127 A18), and the drop of outside content.
 *
 * A block in this body carries an address our storage registered, so each
 * medium put in is judged by its own address (§5.4.4): under our public
 * prefix it stays; an outside address the ingest Worker can fetch, or a
 * `data:` or `blob:` one the browser can read, becomes a pending block whose
 * upload brings it into storage; anything else is left out and the reader is
 * told how many were. A pending block copied from a body keeps its upload id.
 * While our prefix is not known yet, every medium whose address can reach
 * storage becomes pending, and its upload sorts ours from outside once the
 * prefix is in. The uploads start once the paste or the drop is done, for
 * the pending blocks that went in; one that did not go in is counted as left
 * out.
 *
 * A drop of outside content is a paste at the drop point (§5.4.1): what it
 * carries is read first, the caret goes to the drop point (or into an empty
 * line opened there, when the point is in no line of words), the content is
 * put in by the same rules a paste follows, and what it put is selected.
 *
 * Blocks an Agent proposal writes keep only media of ours (inner#1509),
 * through {@link ownMediaOnly}.
 */

import { blockToNode, createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';

import { newId } from '@breatic/shared';

import { assetsApi } from '@web/data/api/assets';
import { addressLanding } from '@web/spaces/document/document-media-address';
import { gapAtDrop, quotedBeside } from '@web/spaces/document/document-file-input';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { isMediaBlockType, pendingUploadId } from '@web/spaces/document/document-media-types';
import { readTransfer } from '@web/spaces/document/document-paste-read';
import { putContent, selectPlaced } from '@web/spaces/document/document-put';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';
import { HOLD_PRE_EDIT_SELECTION } from '@web/spaces/document/document-undo-selection';

/** The key the pasted-media extension registers under. */
export const PASTED_MEDIA_KEY = 'documentPastedMedia';

/** What a paste asks of the pasted-media extension. */
export interface PastedMediaJudge {
  /** Whether a medium at an address lands in the body. */
  lands(url: string): boolean;
  /**
   * How a medium lands: as it is, pending with its upload queued, or null
   * when it is left out (and counted).
   */
  judge(props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null;
  /** Counts media left out, told once the event is done. */
  leaveOut(count: number): void;
}

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
 * The extension that judges pasted media and takes drops of outside content.
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

    /**
     * Once the paste or the drop is done, starts the uploads whose blocks
     * went in and tells how many media were left out, once: those judged out
     * and those whose blocks did not go in.
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

    const media: PastedMediaJudge = {
      lands: (url) => addressLanding(url, options?.assetUrlPrefix() ?? null, options?.start !== undefined) !== null,
      judge: (props) => {
        if (pendingUploadId(props) !== null) return props;
        const url = props['url'];
        const how = typeof url === 'string' ? addressLanding(url, options?.assetUrlPrefix() ?? null, options?.start !== undefined) : null;
        if (how === null) {
          media.leaveOut(1);
          return null;
        }
        if (how === 'ours') return props;
        const uploadId = newId();
        queued.push({ uploadId, url: url as string });
        settle();
        return { ...props, url: '', uploadId };
      },
      leaveOut: (count) => {
        if (count <= 0) return;
        leftOut += count;
        settle();
      },
    };

    return {
      key: PASTED_MEDIA_KEY,
      ...media,
      prosemirrorPlugins: [
        new Plugin({
          props: {
            handleDOMEvents: {
              // A row moved or copied within the body is ProseMirror's own
              // drop; files go to the file drop entry.
              drop: (view, event) => {
                const data = event.dataTransfer;
                if (view.dragging !== null || !view.editable || data === null || Array.from(data.types).includes('Files')) return false;
                const read = readTransfer(editor, data, media.lands);
                event.preventDefault();
                const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
                const $at = at === undefined ? null : view.state.doc.resolve(at);
                // Nothing to put, unless a code block takes the plain text as it is.
                if ($at === null || (read.blocks.length === 0 && !(read.plain !== null && $at.parent.type.spec.code === true))) {
                  media.leaveOut(read.lost);
                  return true;
                }
                const opened = !$at.parent.isTextblock;
                if (opened) {
                  const gap = gapAtDrop(view.state.doc, $at.pos);
                  const line = blockToNode({ id: newId(), type: 'paragraph', props: { [QUOTED]: quotedBeside(view.state.doc, gap) } } as never, view.state.schema);
                  const tr = view.state.tr.insert(gap, line);
                  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, gap + 2)));
                } else {
                  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $at.pos)).setMeta(HOLD_PRE_EDIT_SELECTION, true));
                }
                view.focus();
                const placed = putContent(editor, read, { wordsIntoTarget: true, judge: media.judge, leaveOut: media.leaveOut, openedLine: opened });
                view.dispatch(view.state.tr.setMeta(HOLD_PRE_EDIT_SELECTION, false));
                if (placed !== null) selectPlaced(view, placed);
                return true;
              },
            },
          },
        }),
      ],
    };
  })();
}
