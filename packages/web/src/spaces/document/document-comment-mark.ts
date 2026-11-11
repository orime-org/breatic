// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Registers the comment mark on the body's schema (#18).
 *
 * The mark comes from the library, and with it the four spec values the
 * feature rests on: `excludes: ""` lets two comments overlap the same run,
 * `inclusive: false` keeps text typed at a comment's end outside it,
 * `keepOnSplit: true` carries it across Enter, and the `orphan` attribute is
 * the flag that stops a mark being painted once its thread is gone.
 *
 * This is the registrar for a body built with no thread store behind it —
 * the library's own comments extension is the other, and `commentWiring`
 * picks between them. What matters is that the mark is in the schema either
 * way: `DOCUMENT_SCHEMA_VERSION` is computed from the schema, so a mark that
 * came and went with a runtime option would make this build's vocabulary
 * depend on how the editor was constructed.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { CommentMark } from '@blocknote/core/comments';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as Y from 'yjs';

import { documentCommentThreads } from '@breatic/shared';

import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';

export const documentCommentMarkExtension = createExtension(() => ({
  key: 'documentCommentMark',
  tiptapExtensions: [CommentMark],
}) as never);

/** The class of a comment's highlight, painted by `index.css`. */
export const LIVE_COMMENT_MARK_CLASS = 'doc-comment-mark-live';

const LIVE_KEY = new PluginKey<DecorationSet>('documentCommentLiveMark');

/**
 * Whether a thread is shown: it exists, open and not deleted.
 * @param threads - The threads map.
 * @param threadId - The thread.
 * @returns True when its words are painted.
 */
function threadIsOpen(threads: Y.Map<unknown>, threadId: unknown): boolean {
  const thread = typeof threadId === 'string' ? threads.get(threadId) : undefined;
  return thread instanceof Y.Map && thread.get('resolved') !== true && !thread.get('deletedAt');
}

/**
 * One highlight per marked text run of an open thread. Each is its own
 * `span`, so overlapping comments nest and paint twice, as the marks did.
 * @param doc - The body.
 * @param threads - The threads map.
 * @returns The decorations.
 */
function liveMarks(doc: PMNode, threads: Y.Map<unknown>): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== COMMENT_MARK || !threadIsOpen(threads, mark.attrs.threadId)) continue;
      found.push(Decoration.inline(pos, pos + node.nodeSize, {
        nodeName: 'span', class: LIVE_COMMENT_MARK_CLASS, 'data-thread-id': mark.attrs.threadId as string,
      }));
    }
    return false;
  });
  return found.length > 0 ? DecorationSet.create(doc, found) : DecorationSet.empty;
}

/**
 * Paints a comment's words while its thread is open, read from the threads
 * themselves (inner#1790). The mark's `orphan` flag is the library's own
 * sync, a write to the body that a full Space holds back; the highlight
 * follows the threads in every state.
 * @param doc - The document the threads live in.
 * @returns The extension, for the assembly to register.
 */
export function documentCommentLiveMarkExtension(doc: Y.Doc): ExtensionFactoryInstance {
  const threads = documentCommentThreads(doc);
  return createExtension(() => ({
    key: 'documentCommentLiveMark',
    prosemirrorPlugins: [
      new Plugin<DecorationSet>({
        key: LIVE_KEY,
        state: {
          init: (_config, state) => liveMarks(state.doc, threads),
          apply: (tr, painted, _old, state) => (tr.docChanged || tr.getMeta(LIVE_KEY) === true ? liveMarks(state.doc, threads) : painted),
        },
        /**
         * Repaints when a thread changes, for as long as this view lives.
         * @param view - The editor view.
         * @returns The plugin view, whose destroy stops observing.
         */
        view: (view) => {
          let destroyed = false;
          /** Asks for the paint again, after the change that prompted it. */
          const repaint = (): void => {
            queueMicrotask(() => {
              if (!destroyed) view.dispatch(view.state.tr.setMeta(LIVE_KEY, true).setMeta('addToHistory', false));
            });
          };
          threads.observeDeep(repaint);
          return {
            /** Stops observing. */
            destroy: (): void => {
              destroyed = true;
              threads.unobserveDeep(repaint);
            },
          };
        },
        props: { decorations: (state) => LIVE_KEY.getState(state) },
      }),
    ],
  }) as never)();
}
