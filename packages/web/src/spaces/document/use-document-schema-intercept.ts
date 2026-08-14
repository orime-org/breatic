// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type * as Y from 'yjs';
import {
  DOCUMENT_SCHEMA_META_KEY,
  documentBodyFragment,
  documentSchemaDiffers,
} from '@breatic/shared';

import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_VERSION,
} from '@web/spaces/document/document-schema';

import { findUnknownContent } from '@web/spaces/document/document-schema-guard';

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
  /** This Space's content document. */
  bodyDoc: Y.Doc;
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
 * Two conditions, either one is enough:
 *
 *   1. What the server publishes is not what this build holds. Catches the
 *      classes that leave no trace in the content — an attribute added to a
 *      node both sides already know is dropped silently by ProseMirror, so
 *      nothing about the document itself gives it away.
 *   2. This document holds something this build cannot resolve. Catches the
 *      deployment window where the browser bundle went out before collab
 *      restarted, so meta still says everything is fine while the content
 *      already disagrees.
 *
 * ## Derived, not stored
 *
 * Both conditions are read straight off the two Yjs documents on every render,
 * and re-read whenever either changes. Nothing is kept: switching Space tabs
 * unmounts this and mounting it again recomputes the same answer from the same
 * two documents. A stored flag would have to be kept in step with them, and
 * being out of step is the only way it could be wrong.
 *
 * Missing or malformed published data reads as "no mismatch" (see
 * `documentSchemaDiffers`): not knowing what the server publishes is not the
 * same as knowing it differs.
 * @param root0 - The two documents to derive from.
 * @param root0.metaDoc - The project's meta document.
 * @param root0.bodyDoc - This Space's content document.
 * @returns Whether to intercept, and the server's publish time.
 */
export function useDocumentSchemaIntercept({
  metaDoc,
  bodyDoc,
}: UseDocumentSchemaInterceptInput): DocumentSchemaInterceptState {
  const derive = React.useCallback((): DocumentSchemaInterceptState => {
    const published = readPublished(metaDoc);
    const mismatch = documentSchemaDiffers(DOCUMENT_SCHEMA_VERSION, published);
    // Through `documentBodyFragment`, never a literal key. The key itself is
    // deliberately not exported from `@breatic/shared` so that only one place
    // names it; a second name here would be free to drift from it, and drifting
    // means reading an empty fragment — condition two would answer "nothing
    // unresolvable here" for every document, forever, without erroring once.
    const unknown = findUnknownContent(
      documentBodyFragment(bodyDoc),
      DOCUMENT_SCHEMA,
    );
    // Only condition one carries a publish time. The message built from it says
    // when the newer version went out, and that is only what this timestamp
    // means when the published vocabulary is in fact not this one. Condition two
    // firing on its own is the deployment window — the server is still
    // publishing exactly this build's vocabulary, so the timestamp records the
    // PREVIOUS change and has nothing to do with being behind. Saying nothing
    // beats saying something untrue; the panel already handles not knowing.
    const at = published?.publishedAt;
    return {
      intercepted: mismatch || unknown.length > 0,
      publishedAt: mismatch && typeof at === 'string' ? at : null,
    };
  }, [metaDoc, bodyDoc]);

  const [state, setState] = React.useState<DocumentSchemaInterceptState>(derive);

  React.useEffect(() => {
    /**
     * Recompute from both documents, and keep the previous object when the
     * answer has not moved.
     *
     * Yjs fires `update` on every keystroke, local and remote alike, and both
     * documents are subscribed. Handing back a fresh object literal each time
     * would fail `Object.is` on every one of them and re-render the subtree for
     * an answer that changed on almost none — twice over, since the tab-scoped
     * guard runs this hook as well.
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

    // Both documents can change after mount and either changes the answer: the
    // published vocabulary arrives on reconnect, and unresolvable content can
    // arrive at any moment from a peer running a newer build.
    metaDoc.on('update', update);
    bodyDoc.on('update', update);
    update();

    return () => {
      metaDoc.off('update', update);
      bodyDoc.off('update', update);
    };
  }, [metaDoc, bodyDoc, derive]);

  return state;
}
