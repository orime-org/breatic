// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Files put into a body by paste, drop or the insert menu (inner#1351 +
 * inner#1390 design §5.9).
 *
 * Each file is admitted at once on the canvas's rules plus the body's own; a
 * refused one is told and makes nothing. Each admitted file becomes a pending
 * media block, which the entry puts in where the reader aimed, and its upload
 * starts once the block is in. Where the block goes and what it shows from
 * then on belong to the entry and the page's upload controller.
 */

import {
  checkFileAdmission,
  fileToNodeSpec,
  refusedFormatParams,
  type FileRejection,
} from '@web/spaces/canvas/canvas-upload';
import { newId } from '@breatic/shared';

import type { MediaBlockType } from '@web/spaces/document/document-media-types';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';

/** A pending media block, as BlockNote takes a block to insert. */
export interface PendingBlock {
  readonly type: MediaBlockType;
  readonly props: {
    readonly url: '';
    readonly uploadId: string;
    readonly name: string;
    readonly caption: string;
    readonly mediaWidth?: number;
    readonly mediaHeight?: number;
  };
}

/**
 * A pending media block.
 * @param type - Its media type.
 * @param uploadId - The upload behind it.
 * @param name - The file's or the node's name.
 * @param caption - Its caption.
 * @param size - Its pixel size, when known before the upload ends.
 * @param size.mediaWidth - Its width.
 * @param size.mediaHeight - Its height.
 * @returns The block.
 */
export function pendingBlock(
  type: MediaBlockType,
  uploadId: string,
  name: string,
  caption: string,
  size: { mediaWidth?: number; mediaHeight?: number } = {},
): PendingBlock {
  return { type, props: { url: '', uploadId, name, caption, ...size } };
}

/** What the file entries need from the page. */
export interface FileUploadsDeps {
  /** The upload cap as this page knows it now; `Infinity` before it is read. */
  readonly maxUploadBytes: () => number;
  /** Says why a file was turned away. */
  readonly refuse: (messageKey: string, params: Readonly<Record<string, string>>) => void;
  /** Starts the upload behind a pending block. */
  readonly start: (uploadId: string, source: UploadSource) => void;
}

/** Admitted files: their blocks, and what starts their uploads once the blocks are in. */
export interface PreparedFiles {
  readonly blocks: readonly PendingBlock[];
  start(): void;
}

/** What admits files into a body. */
export interface FileUploads {
  /**
   * Admits the files; a refused one is told.
   * @returns Their blocks, or null when none is admitted.
   */
  prepare(files: readonly File[]): PreparedFiles | null;
}

/**
 * Why a file may not enter the body, or null to admit it: the canvas's rules,
 * plus one of the body's own — a file that is not an image, a video or an
 * audio has no block to become.
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
 * Builds a body's file admission.
 * @param deps - What it needs from the page.
 * @returns The admission.
 */
export function createFileUploads(deps: FileUploadsDeps): FileUploads {
  return {
    prepare(files) {
      const maxBytes = deps.maxUploadBytes();
      const admitted: { file: File; block: PendingBlock }[] = [];
      for (const file of files) {
        const rejection = rejectionOf(file, maxBytes);
        if (rejection !== null) {
          deps.refuse(`canvas.upload.${rejection}`, { filename: file.name, ...refusedFormatParams(file) });
          continue;
        }
        const type = fileToNodeSpec(file).nodeType as MediaBlockType;
        admitted.push({ file, block: pendingBlock(type, newId(), file.name, '') });
      }
      if (admitted.length === 0) return null;
      return {
        blocks: admitted.map(({ block }) => block),
        start: () => {
          for (const { file, block } of admitted) deps.start(block.props.uploadId, { kind: 'file', file });
        },
      };
    },
  };
}
