// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type * as Y from 'yjs';
import {
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  documentSchemaDiffers,
} from '@breatic/shared';

/** What the caller needs to decide whether to build an editor at all. */
export interface DocumentSchemaInterceptState {
  /** True when this build must not offer to edit this document. */
  intercepted: boolean;
  /** When the server's vocabulary was last published, for the message. */
  publishedAt: string | null;
}

interface UseDocumentSchemaInterceptInput {
  /** The project's meta document, where the server publishes its vocabulary. */
  metaDoc: Y.Doc;
}

/**
 * Read whichever vocabulary the server has published into meta.
 * @param metaDoc - The project's meta document.
 * @returns The published entry, or undefined when nothing is there yet.
 */
function readPublished(metaDoc: Y.Doc): Record<string, unknown> | undefined {
  const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
  return map.size === 0 ? undefined : (map.toJSON());
}

/**
 * Whether this build should refuse to open a document Space, and why the user
 * is being told about it now.
 *
 * One condition: what the server publishes is not what this build holds. The
 * version is a digest of the vocabulary lists, so it also catches the classes
 * that leave no trace in the content — an attribute added to a node both
 * sides already know is dropped silently by ProseMirror, and nothing but the
 * version can catch it.
 *
 * Content this build cannot resolve is deliberately NOT a condition (ruled
 * 2026-08-17, structure decision record §7). A vocabulary entry the server
 * retired lives on in every document seeded before the change, and a
 * content-based intercept would lock a fully up-to-date client out of those
 * documents forever. Unresolvable content renders through the Unsupported
 * fallbacks instead, whose round trip preserves it byte for byte — so meeting
 * it is not a reason to stop editing.
 *
 * ## Derived, not stored across mounts
 *
 * The verdict is read straight off the meta document once on mount and again
 * whenever it changes. The answer is held in component state so renders in
 * between reuse it, but nothing outlives the mount: switching Space tabs
 * unmounts this, and mounting it again derives the same answer from the same
 * document. A flag kept anywhere more durable would have to be held in step
 * with it, and being out of step is the only way it could be wrong.
 *
 * Missing or malformed published data reads as "no mismatch" (see
 * `documentSchemaDiffers`): not knowing what the server publishes is not the
 * same as knowing it differs.
 * @param root0 - The document to derive from.
 * @param root0.metaDoc - The project's meta document.
 * @returns Whether to intercept, and the server's publish time.
 */
export function useDocumentSchemaIntercept({
  metaDoc,
}: UseDocumentSchemaInterceptInput): DocumentSchemaInterceptState {
  const derive = React.useCallback((): DocumentSchemaInterceptState => {
    const published = readPublished(metaDoc);
    const mismatch = documentSchemaDiffers(DOCUMENT_SCHEMA_VERSION, published);
    // The publish time is the server vocabulary's own release date, written
    // by hand on `DOCUMENT_SCHEMA` and republished unchanged — when the
    // versions disagree it is what the panel shows.
    const at = published?.publishedAt;
    return {
      intercepted: mismatch,
      publishedAt: typeof at === 'string' ? at : null,
    };
  }, [metaDoc]);

  const [state, setState] = React.useState<DocumentSchemaInterceptState>(derive);

  React.useEffect(() => {
    /**
     * Recompute from the meta document, and keep the previous object when the
     * answer has not moved.
     *
     * Yjs fires `update` on every change, local and remote alike. Handing
     * back a fresh object literal each time would fail `Object.is` on every
     * one of them and re-render the subtree for an answer that changed on
     * almost none — twice over, since the tab-scoped guard runs this hook as
     * well.
     * @returns Nothing.
     */
    const update = (): void =>
      setState((prev) => {
        const next = derive();
        return prev.intercepted === next.intercepted &&
          prev.publishedAt === next.publishedAt
          ? prev
          : next;
      });

    // The published vocabulary can arrive after mount — on reconnect, or when
    // the server restarts onto a new release.
    metaDoc.on('update', update);
    update();

    return () => {
      metaDoc.off('update', update);
    };
  }, [metaDoc, derive]);

  return state;
}
