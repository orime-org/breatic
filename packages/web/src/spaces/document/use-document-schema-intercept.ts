// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * fallbacks instead — so meeting it is not a reason to stop editing.
 *
 * What the fallbacks hold is the block position, which is where a retired
 * vocabulary entry lands: a name this build does not know, sitting where a
 * block's content goes, survives binding and every edit around it byte for
 * byte. A name in a STRUCTURAL position — directly under a block group, or at
 * the root of the fragment — has no fallback shaped like it, so ProseMirror
 * wraps it and the first transaction writes that wrapping back. No vocabulary
 * this build has retired reaches those positions.
 *
 * ## Derived, not stored across mounts
 *
 * The verdict is read straight off the meta document once on mount and again
 * whenever it changes. The answer is held in component state so renders in
 * between reuse it, but nothing outlives the mount: closing the Space's tab
 * unmounts this, and opening it again derives the same answer from the same
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

  // Read during render, so a change that lands while the Space is hidden is
  // what the first render on the way back sees (inner#1235): the editor below
  // reads it in an effect that runs before this component's own.
  //
  // Yjs fires `update` on every change, local and remote alike, so the
  // snapshot keeps the previous object while the answer has not moved;
  // a fresh literal each time would re-render the subtree for nothing.
  const last = React.useRef<DocumentSchemaInterceptState | null>(null);
  const getSnapshot = React.useCallback((): DocumentSchemaInterceptState => {
    const next = derive();
    const prev = last.current;
    if (
      prev !== null &&
      prev.intercepted === next.intercepted &&
      prev.publishedAt === next.publishedAt
    ) {
      return prev;
    }
    last.current = next;
    return next;
  }, [derive]);
  // The published vocabulary can arrive after mount — on reconnect, or when
  // the server restarts onto a new release.
  const subscribe = React.useCallback(
    (onChange: () => void): (() => void) => {
      metaDoc.on('update', onChange);
      return () => {
        metaDoc.off('update', onChange);
      };
    },
    [metaDoc],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot);
}
