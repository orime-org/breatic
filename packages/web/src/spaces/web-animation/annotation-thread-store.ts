// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Motion Space's annotation threads (#1490 design §10.2): the same BlockNote `YjsThreadStore`, authorization and
 * size gate the Document comments use, under the root key `webAnimationAnnotationThreads` of the Motion Space's own
 * document. No editor is involved: the Space reads and writes the store directly.
 */

import { YjsThreadStore } from '@blocknote/core/yjs';
import type * as Y from 'yjs';

import { webAnimationAnnotationThreads } from '@breatic/shared';

import { documentCommentAuth, type DocumentCommentAuthInput } from '@web/spaces/document/document-comment-auth';
import { sizeGated } from '@web/spaces/document/document-comment-thread-store';

/** What the store is built from. */
export interface AnnotationStoreOptions {
  /** The Motion Space's content document. */
  readonly doc: Y.Doc;
  /** Who is reading, asked afresh for every authorization answer. */
  readonly readWho: () => DocumentCommentAuthInput;
}

/**
 * The thread store of one Motion Space.
 * @param options - The document and who reads it.
 * @returns The size-gated store.
 * @throws {never} Never.
 */
export function webAnimationAnnotationStore(options: AnnotationStoreOptions): YjsThreadStore {
  return sizeGated(
    new YjsThreadStore(options.readWho().viewerId ?? '', webAnimationAnnotationThreads(options.doc), documentCommentAuth(options.readWho)),
    options.doc,
    webAnimationAnnotationThreads,
  );
}
