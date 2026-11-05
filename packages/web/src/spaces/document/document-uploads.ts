// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import { reserveSpaceRoom, type SpaceReservation } from '@web/data/yjs/space-write';
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
import { isMediaBlockType } from '@web/spaces/document/document-media-types';
import {
  addUploadBatch,
  insertSlotBlock,
  mediaBlockBytes,
  patchUploadSlot,
  removeUploadSlot,
  sizeFailure,
  uploadSlots,
  type SlotFailure,
  type UndoCapture,
  type UploadGap,
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
  /** Closes the reader's undo step around a batch's start and each insert. */
  readonly undo: UndoCapture;
  /**
   * The Space document the blocks land in, whose size each upload reserves
   * room in before it is sent (inner#1790). Left out, or null, nothing is
   * reserved.
   */
  readonly spaceDocName?: () => string | null;
}

/** What the entries and the placeholders call. */
export interface DocumentUploader {
  /**
   * Admits the files and starts the ones that pass at one gap, asked for only
   * once at least one file is admitted (the insert menu makes its gap then);
   * null puts nothing anywhere. `aimed` says the reader aimed the files at
   * the empty line right after the gap (its insert menu, or a paste with the
   * caret in it), so they land quoted as that line.
   */
  start(view: EditorView, files: readonly File[], place: () => UploadGap | null, aimed: boolean): Promise<void>;
  /** Sends a failed file again, when doing so can end differently. */
  retry(view: EditorView, slotId: string): void;
  /** Takes a failed placeholder away. */
  remove(view: EditorView, slotId: string): void;
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
  const held = new Map<string, File>();
  /** Room each upload in flight holds for its block. */
  const reserved = new Map<string, SpaceReservation>();

  /**
   * Gives back the room an upload held, when it ends without a block or its
   * block has landed (then the write holds it until the server counts it).
   * @param slotId - Which slot.
   */
  function release(slotId: string): void {
    reserved.get(slotId)?.release();
    reserved.delete(slotId);
  }

  /**
   * Reserves room for a slot's block, failing the slot when there is none.
   * @param view - The editor view.
   * @param slotId - Which slot.
   * @param file - Its file.
   * @returns Whether the upload may be sent.
   */
  function reserve(view: EditorView, slotId: string, file: File): boolean {
    const name = deps.spaceDocName?.() ?? null;
    if (name === null) return true;
    const { nodeType } = fileToNodeSpec(file);
    const result = reserveSpaceRoom(name, mediaBlockBytes(view.state, isMediaBlockType(nodeType) ? nodeType : 'image', file.name), { notify: false });
    if (!result.ok) {
      patchUploadSlot(view, slotId, { phase: 'failed', failure: sizeFailure(result) });
      return false;
    }
    reserved.set(slotId, result.reservation);
    return true;
  }

  /**
   * Runs one upload to its end.
   * @param view - The editor view.
   * @param slotId - Which slot.
   */
  async function run(view: EditorView, slotId: string): Promise<void> {
    const file = held.get(slotId);
    if (file === undefined || !reserve(view, slotId, file)) return;
    deps.register(slotId);
    let stored: StoredUpload;
    try {
      stored = await deps.upload(file, (progress) => {
        patchUploadSlot(view, slotId, { progress });
      });
    } catch (err) {
      deps.unregister(slotId);
      release(slotId);
      patchUploadSlot(view, slotId, { phase: 'failed', failure: failureOf(err, file) });
      return;
    }
    deps.unregister(slotId);
    // Bound to the insert below if it lands; given back however this ends.
    const reservation = reserved.get(slotId);
    reserved.delete(slotId);
    // The kind the server read off the stored bytes, not the name's guess.
    if (!isMediaBlockType(stored.kind)) {
      reservation?.release();
      patchUploadSlot(view, slotId, {
        phase: 'failed',
        failure: failureOf(new UploadFailedError('unsupportedType'), file),
      });
      return;
    }
    if (!view.editable) {
      reservation?.release();
      patchUploadSlot(view, slotId, { phase: 'failed', failure: READ_ONLY });
      return;
    }
    const landed = insertSlotBlock(
      view,
      slotId,
      {
        type: stored.kind,
        props: {
          url: stored.fileUrl,
          name: file.name,
          // The size the server read off the stored picture, which for one with
          // an EXIF orientation is its upright copy (inner#1367 §4.8a).
          ...(typeof stored.width === 'number' &&
            typeof stored.height === 'number' && { mediaWidth: stored.width, mediaHeight: stored.height }),
        },
      },
      deps.undo,
      reservation,
    );
    // A no-op once the insert holds it; gives it back after a refused insert.
    reservation?.release();
    // A slot the Space's size refused stays, to be sent again.
    if (landed !== null || !uploadSlots(view.state).some((s) => s.id === slotId)) held.delete(slotId);
  }

  return {
    async start(view, files, place, aimed) {
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
      const ids = addUploadBatch(view, gap, admitted.map((file) => file.name), aimed, deps.undo);
      ids.forEach((slotId, k) => {
        held.set(slotId, admitted[k]!);
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
      release(slotId);
      removeUploadSlot(view, slotId);
    },
  };
}
