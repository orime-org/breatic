// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One open body's link to the page's upload controller (inner#1351 +
 * inner#1390 design §5.5). Opened when the body's editor is built and closed
 * when it is evicted, which is what "an open body" means: built, and not
 * stopped by an outdated vocabulary.
 *
 * Its pending blocks read four things through it: this page's record of an
 * upload, this page's write access to the body, whether the server refused
 * the body, and what other clients claim in awareness.
 */

import type * as Y from 'yjs';

import { claimIn } from '@web/spaces/document/document-pending-status';
import type { PendingUploadsStore } from '@web/spaces/document/document-pending-uploads';
import type { WriteAccess } from '@web/data/yjs/collab-socket';
import type { ClaimChannel, UploadController, UploadSource } from '@web/spaces/document/document-upload-controller';

/** The awareness a body publishes claims in and reads others' from. */
export interface BodyAwareness extends ClaimChannel {
  getStates: () => Map<number, Record<string, unknown>>;
  on: (event: 'change', listener: () => void) => void;
  off: (event: 'change', listener: () => void) => void;
}

/** What this page's connection to a body says. */
export interface BodyConnection {
  /** Absent for a body with no connection behind it. */
  readonly awareness?: BodyAwareness;
  /** This page's write access, read now. */
  writeAccess: () => WriteAccess;
  /** Whether the server refused this page the body, read now. */
  refused: () => boolean;
  /**
   * Calls back whenever either may have changed.
   * @returns What stops listening.
   */
  onChange: (listener: () => void) => () => void;
}

/** A body's link to the page's uploads. */
export interface BodyUploads {
  /** Starts the upload behind a pending block put into this body. */
  start: (uploadId: string, source: UploadSource) => void;
  /** What the body's pending blocks read. */
  pending: PendingUploadsStore;
  /** Closes the link: the body's claims and guard registrations go. */
  detach: () => void;
}

/**
 * Opens a body's link to the page's uploads.
 * @param controller - The page's controller.
 * @param body - The body.
 * @param body.spaceId - Its Space.
 * @param body.doc - Its document.
 * @param body.connection - This page's connection to it.
 * @returns The link.
 */
export function openBodyUploads(
  controller: UploadController,
  body: { spaceId: string; doc: Y.Doc; connection: BodyConnection },
): BodyUploads {
  const { connection } = body;
  const detach = controller.attach({ spaceId: body.spaceId, doc: body.doc, ...connection });
  const pending: PendingUploadsStore = {
    factsOf: (uploadId) => ({
      entry: controller.entry(uploadId),
      access: connection.writeAccess(),
      refused: connection.refused(),
      claim: connection.awareness === undefined ? null : claimIn(connection.awareness.getStates(), uploadId),
    }),
    subscribe: (listener) => {
      const stopController = controller.subscribe(listener);
      const stopConnection = connection.onChange(listener);
      connection.awareness?.on('change', listener);
      return () => {
        stopController();
        stopConnection();
        connection.awareness?.off('change', listener);
      };
    },
    retry: (uploadId) => {
      controller.retry(uploadId);
    },
  };
  return {
    start: (uploadId, source) => {
      controller.start(uploadId, source);
    },
    pending,
    detach,
  };
}
