// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One file's way from being picked to being a block (inner#1127 §3.4).
 *
 * The three entries — the insert menu, a drop, a paste — hand their files here
 * with the gap they go into. Each file is admitted on the same rules as the
 * canvas, uploaded with no node behind it, and either lands as a media block
 * where its placeholder is drawn or stops as a failed placeholder that says
 * why. The placeholders themselves live in `document-upload-slots`.
 */

import type { EditorView } from '@tiptap/pm/view';

import { UploadFailedError, type StoredUpload } from '@web/data/upload/media-upload';
import {
  checkFileAdmission,
  fileToNodeSpec,
  refusedFormatParams,
  type FileRejection,
} from '@web/spaces/canvas/canvas-upload';
import {
  uploadFailureMessageKey,
  uploadRetryCanChange,
} from '@web/spaces/canvas/upload-failure';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { isMediaBlockType } from '@web/spaces/document/document-media-types';
import {
  addUploadBatch,
  insertSlotBlock,
  patchUploadSlot,
  removeUploadSlot,
  uploadSlots,
  type SlotAnchor,
  type SlotFailure,
  type UndoCapture,
} from '@web/spaces/document/document-upload-slots';

/** What the uploader needs from the page. */
export interface DocumentUploaderDeps {
  /** The upload cap; `Infinity` when it could not be read. */
  readonly maxUploadBytes: () => Promise<number>;
  /** Uploads one file with no node behind it (`uploadMedia`). */
  readonly upload: (file: File, onProgress: (fraction: number) => void) => Promise<StoredUpload>;
  /** Marks an upload as in flight, so leaving asks first. */
  readonly register: (operationId: string) => void;
  /** Ends what {@link DocumentUploaderDeps.register} started. */
  readonly unregister: (operationId: string) => void;
  /** Says why a file was turned away before it was sent. */
  readonly refuse: (messageKey: string, params: Readonly<Record<string, string>>) => void;
  /** Keeps each insert one undo step of its own. */
  readonly undo: UndoCapture;
}

/** Where admitted files go, and whether that gap is inside a quote. */
export interface UploadGap {
  readonly anchor: SlotAnchor;
  readonly quoted: boolean;
}

/** What the entries and the placeholders call. */
export interface DocumentUploader {
  /**
   * Admits the files and starts the ones that pass at one gap, asked for only
   * once at least one file is admitted (the insert menu makes its gap then);
   * null puts nothing anywhere.
   */
  start(view: EditorView, files: readonly File[], place: () => UploadGap | null): Promise<void>;
  /** Sends a failed file again, when doing so can end differently. */
  retry(view: EditorView, slotId: string): void;
  /** Takes a failed placeholder away. */
  remove(view: EditorView, slotId: string): void;
}

/** A file that was admitted, and what it needs to become a block. */
interface Held {
  readonly file: File;
  readonly quoted: boolean;
}

/** The failure a body that stopped being editable meanwhile shows. */
const READ_ONLY: SlotFailure = {
  messageKey: 'spaces.document.media.readOnly',
  params: {},
  retryable: true,
};

/**
 * Why a file may not enter the body, or null to admit it.
 *
 * The canvas's rules, plus one of the body's own: a file that is not an
 * image, a video or an audio has no block to become.
 * @param file - The file.
 * @param maxBytes - The upload cap.
 * @returns The refusal, or null.
 */
function rejectionOf(file: File, maxBytes: number): FileRejection | null {
  const rejection = checkFileAdmission(file, maxBytes);
  if (rejection !== null) return rejection;
  return fileToNodeSpec(file).needsUpload ? null : 'unsupportedType';
}

/**
 * The failure a placeholder shows for an upload that ended badly.
 * @param err - What the upload rejected with.
 * @param file - The file.
 * @returns The failure.
 */
function failureOf(err: unknown, file: File): SlotFailure {
  const reason = err instanceof UploadFailedError ? err.reason : 'upload';
  return {
    messageKey: uploadFailureMessageKey(reason),
    params: { filename: file.name, ...refusedFormatParams(file) },
    retryable: uploadRetryCanChange(reason),
  };
}

/**
 * Builds an uploader for one body.
 * @param deps - What it needs from the page.
 * @returns The uploader.
 */
export function createDocumentUploader(deps: DocumentUploaderDeps): DocumentUploader {
  const held = new Map<string, Held>();

  /**
   * Runs one upload to its end.
   * @param view - The editor view.
   * @param slotId - Which slot.
   */
  async function run(view: EditorView, slotId: string): Promise<void> {
    const entry = held.get(slotId);
    if (entry === undefined) return;
    deps.register(slotId);
    let stored: StoredUpload;
    try {
      stored = await deps.upload(entry.file, (progress) => {
        patchUploadSlot(view, slotId, { progress });
      });
    } catch (err) {
      deps.unregister(slotId);
      patchUploadSlot(view, slotId, { phase: 'failed', failure: failureOf(err, entry.file) });
      return;
    }
    deps.unregister(slotId);
    if (stored.fileUrl === undefined || stored.kind === undefined) {
      patchUploadSlot(view, slotId, {
        phase: 'failed',
        failure: failureOf(new UploadFailedError('upload'), entry.file),
      });
      return;
    }
    // The kind the server read off the stored bytes, not the name's guess.
    if (!isMediaBlockType(stored.kind)) {
      patchUploadSlot(view, slotId, {
        phase: 'failed',
        failure: failureOf(new UploadFailedError('unsupportedType'), entry.file),
      });
      return;
    }
    if (!view.editable) {
      patchUploadSlot(view, slotId, { phase: 'failed', failure: READ_ONLY });
      return;
    }
    insertSlotBlock(
      view,
      slotId,
      {
        type: stored.kind,
        props: { url: stored.fileUrl, name: entry.file.name, [QUOTED]: entry.quoted },
      },
      deps.undo,
    );
    held.delete(slotId);
  }

  return {
    async start(view, files, place) {
      const maxBytes = await deps.maxUploadBytes();
      const admitted: File[] = [];
      for (const file of files) {
        const rejection = rejectionOf(file, maxBytes);
        if (rejection === null) {
          admitted.push(file);
        } else {
          deps.refuse(`canvas.upload.${rejection}`, {
            filename: file.name,
            ...refusedFormatParams(file),
          });
        }
      }
      if (admitted.length === 0) return;
      const gap = place();
      if (gap === null) return;
      const ids = addUploadBatch(view, gap.anchor, admitted.map((file) => file.name));
      ids.forEach((slotId, k) => {
        held.set(slotId, { file: admitted[k]!, quoted: gap.quoted });
        void run(view, slotId);
      });
    },

    retry(view, slotId) {
      const slot = uploadSlots(view.state).find((s) => s.id === slotId);
      if (slot?.phase !== 'failed' || slot.failure?.retryable !== true) return;
      patchUploadSlot(view, slotId, { phase: 'uploading', progress: null, failure: null });
      void run(view, slotId);
    },

    remove(view, slotId) {
      held.delete(slotId);
      removeUploadSlot(view, slotId);
    },
  };
}
