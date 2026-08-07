// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Noticing that a document changed, and forgetting it once it is gone (#40).
 *
 * WHY THIS LISTENS TO THE DOCUMENT RATHER THAN TO `onChange`.
 * The counter used to live in the server's config-level `onChange` hook.
 * `configure()` sorts the extensions by priority and then PUSHES the
 * config-level hooks onto the end of that array, so it ran behind every
 * extension — including the Redis one, which publishes each update to the
 * other instances. `hooks()` chains them with `.then`, so a publish that
 * rejects skips every hook behind it. The counter never moved, the document
 * read as clean, the timed loop skipped it and the unload gate let it go:
 * content a person had typed, gone, with nothing logged. Losing Redis is not
 * a reason to lose a paragraph.
 *
 * Moving further up the queue would only shorten the odds. The Yjs document's
 * own `update` event is where the library's `onChange` comes from in the first
 * place — `hocuspocus-server.esm.js:512` binds it, `:679` forwards it, `:1404`
 * fires the hooks — so listening to the document directly gets the same events
 * one step earlier, synchronously inside the transaction, with nothing in
 * between that can fail.
 *
 * The extension still needs a hook to reach the document, and the priority
 * below is what keeps that reach from being cut off the same way.
 */

import type * as Y from "yjs";
import { forgetDocument, noteDocumentChange } from "@collab/services/store-tracker.js";

/**
 * Runs before every other extension.
 *
 * Extensions default to 100 and the Redis one declares 1000, the highest of
 * any we ship. Being first is what makes this the one hook nothing can abort
 * ahead of — every other extension is behind it in every chain, so no
 * rejection of theirs can stop the listener from being attached.
 */
const BEFORE_EVERY_OTHER_EXTENSION = 10_000;

/** What hocuspocus hands the load hook. */
interface LoadedDocument {
  documentName: string;
  document: Y.Doc;
}

/** The two lifecycle hooks the tracker needs. */
export interface ChangeTrackingExtension {
  /** Highest of any extension, so nothing can abort the chain ahead of us. */
  priority: number;
  /** Start watching a document that has finished loading. */
  afterLoadDocument(payload: LoadedDocument): Promise<void>;
  /** Stop watching, and drop the bookkeeping, once it has left memory. */
  afterUnloadDocument(payload: { documentName: string }): Promise<void>;
}

/**
 * Build the change-tracking extension.
 * @returns The hooks to register on the Hocuspocus server.
 */
export function createChangeTrackingExtension(): ChangeTrackingExtension {
  /** Live listeners, so each can be detached from the document it watches. */
  const watching = new Map<string, { document: Y.Doc; handler: () => void }>();

  return {
    priority: BEFORE_EVERY_OTHER_EXTENSION,

    afterLoadDocument: async ({ documentName, document }): Promise<void> => {
      // AFTER rather than during loading. `onLoadDocument` is where
      // persistence applies the stored bytes, and a listener attached before
      // that would count the load as a change — so the first timed round
      // would write back exactly what it had just read. By the time this
      // runs, loading is done and no connection can have sent anything yet:
      // the library only publishes the document once `loadDocument` resolves.
      if (watching.has(documentName)) return;

      /** Count one update against this document, whatever produced it. */
      const handler = (): void => {
        noteDocumentChange(documentName);
      };
      document.on("update", handler);
      watching.set(documentName, { document, handler });
    },

    afterUnloadDocument: async ({ documentName }): Promise<void> => {
      // Only now are the counters safe to drop. hocuspocus re-checks
      // `shouldUnloadDocument` after `beforeUnloadDocument` returns and
      // abandons the unload when a connection arrived meanwhile, so clearing
      // any earlier would mark a live document holding unstored content as
      // clean and the timed loop would skip it from then on. This hook only
      // fires once the document has actually been destroyed.
      const watched = watching.get(documentName);
      if (watched) {
        watched.document.off("update", watched.handler);
        watching.delete(documentName);
      }
      forgetDocument(documentName);
    },
  };
}
