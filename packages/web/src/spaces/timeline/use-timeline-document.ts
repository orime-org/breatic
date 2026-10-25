// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type * as Y from 'yjs';
import { readTimelineDocument, type TimelineDocumentV1 } from '@breatic/shared';

/** The current supported content or the format error reported by its reader. */
export interface TimelineDocumentState {
  document: TimelineDocumentV1 | null;
  error: Error | null;
}

/**
 * Read a supported version before binding its collection handles.
 * @param doc - The existing Space content document.
 * @param enabled - Whether server content has arrived.
 * @returns The supported projection or its format error.
 * @throws {never} Never.
 */
function readState(doc: Y.Doc, enabled: boolean): TimelineDocumentState {
  if (!enabled) return { document: null, error: null };
  try {
    if (!doc.share.has('timeline') || doc.getMap('timeline').get('schemaVersion') !== 1) {
      throw new Error('Unsupported Timeline content');
    }
    return { document: readTimelineDocument(doc), error: null };
  } catch (error) {
    return { document: null, error: error instanceof Error ? error : new Error('Invalid Timeline content') };
  }
}

/**
 * Read the Timeline content held by the existing Space connection.
 * @param doc - The actual Space content document.
 * @param enabled - Whether the first shared content has arrived.
 * @returns The current supported Timeline content and read error.
 * @throws {never} Never.
 */
export function useTimelineDocument(doc: Y.Doc, enabled: boolean): TimelineDocumentState {
  const store = React.useMemo(() => {
    let snapshot = readState(doc, enabled);
    return {
      /**
       * Read the stable snapshot required by React's subscription contract.
       * @returns The current content projection.
       * @throws {never} Never.
       */
      getSnapshot(): TimelineDocumentState { return snapshot; },
      /**
       * Subscribe to the existing document while this body is visible.
       * @param notify - React's content-change listener.
       * @returns The subscription release function.
       * @throws {never} Never.
       */
      subscribe(notify: () => void): () => void {
        if (!enabled) return () => {};
        /** Publish a complete projection after one collaborative transaction. */
        const update = (): void => {
          snapshot = readState(doc, true);
          notify();
        };
        doc.on('update', update);
        update();
        return () => doc.off('update', update);
      },
    };
  }, [doc, enabled]);
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
