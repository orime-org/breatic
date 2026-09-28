// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from '@breatic/shared';

import { checkFileAdmission, uploadAcceptFor } from '@web/spaces/canvas/canvas-upload';
import { pickExtractor } from '@web/spaces/canvas/text-extract';
import {
  chatAttachments,
  type AttachmentLimits,
  type TrayItem,
} from '@web/stores/chat-attachments';

/** What the attach button can say about a batch it was handed. */
export type AttachNotice =
  | { key: 'full'; limit: number }
  | { key: 'tooLong' }
  | { key: 'unsupported'; filename: string }
  | { key: 'tooLarge'; filename: string };

/** What attaching needs from outside. Injected so it can be exercised alone. */
export interface AttachDeps {
  /** The limits the server holds one message's attachments to. */
  limits: () => Promise<AttachmentLimits>;
  /** The largest file that may be uploaded, in bytes. */
  maxUploadBytes: () => Promise<number>;
  /** Upload a media file, answering the address it was filed under. */
  upload: (file: File, projectId: string) => Promise<string | undefined>;
  /** Read a document's text. */
  extract: (file: File) => Promise<string>;
  /** A fresh id for an item that has no canvas node behind it. */
  newId: () => string;
}

/** Where the files are attached. */
export interface AttachTarget {
  conversationId: string;
  projectId: string;
}

/** The media kinds a file can be sent as. */
type MediaKind = 'image' | 'video' | 'audio';

/** The document types the picker offers, beside the media it offers. */
const DOCUMENT_ACCEPT = [
  '.pdf',
  '.docx',
  '.xlsx',
  '.xls',
  '.txt',
  'text/plain',
  'application/pdf',
];

/**
 * What the attach button's file picker offers.
 * @returns A comma-separated `accept` value.
 */
export function attachAccept(): string {
  return [
    uploadAcceptFor('image'),
    uploadAcceptFor('video'),
    uploadAcceptFor('audio'),
    ...DOCUMENT_ACCEPT,
  ].join(',');
}

/**
 * Which media kind a file is, going by its type.
 * @param file - The file.
 * @returns Its kind, or null when it is not media.
 */
function mediaKindOf(file: File): MediaKind | null {
  const family = file.type.split('/')[0];
  return family === 'image' || family === 'video' || family === 'audio' ? family : null;
}

/** A file that will be attached, and how it is read. */
interface Accepted {
  file: File;
  item: TrayItem;
  media: boolean;
}

/**
 * Sort the picked files into what will be attached and what is turned away.
 * @param files - What was picked.
 * @param maxBytes - The largest file that may be uploaded.
 * @param newId - Makes an id for each accepted file.
 * @returns The accepted files, and the first thing to say about the rest.
 */
function sortPicked(
  files: readonly File[],
  maxBytes: number,
  newId: () => string,
): { accepted: Accepted[]; notice: AttachNotice | null } {
  const accepted: Accepted[] = [];
  let notice: AttachNotice | null = null;
  for (const file of files) {
    const kind = mediaKindOf(file);
    const readable = kind === null && pickExtractor(file.type) !== null;
    const rejection = kind || readable ? checkFileAdmission(file, maxBytes) : 'unsupportedType';
    if (rejection !== null) {
      notice ??=
        rejection === 'tooLarge'
          ? { key: 'tooLarge', filename: file.name }
          : { key: 'unsupported', filename: file.name };
      continue;
    }
    accepted.push({
      file,
      media: kind !== null,
      item: { id: newId(), name: file.name, type: kind ?? 'text', status: 'uploading' },
    });
  }
  return { accepted, notice };
}

/**
 * Upload or read one accepted file, and settle its item.
 * @param picked - The file and its item.
 * @param target - Where it is attached.
 * @param limits - The limits the list is held to.
 * @param deps - What reading and uploading need.
 * @returns True when its content made the list too long.
 */
async function fillIn(
  picked: Accepted,
  target: AttachTarget,
  limits: AttachmentLimits,
  deps: AttachDeps,
): Promise<boolean> {
  const { file, item, media } = picked;
  const base = { id: item.id, type: item.type, name: item.name };
  let chip: ChatAttachedChip;
  try {
    if (media) {
      const url = await deps.upload(file, target.projectId);
      if (url === undefined) throw new Error('upload answered no address');
      chip = { ...base, data_snapshot: { url } };
    } else {
      chip = { ...base, data_snapshot: { text: await deps.extract(file) } };
    }
  } catch {
    // The item says it failed, which is what the reader acts on: take it out
    // and pick the file again.
    chatAttachments.fail(target.conversationId, item.id, media ? 'upload' : 'extract');
    return false;
  }
  return chatAttachments.settle(target.conversationId, item.id, chip, limits) === 'too_long';
}

/**
 * Attach the files a reader picked.
 *
 * The batch goes in whole or not at all, each item uploading; then each is
 * uploaded or read on its own and turns ready or failed. Files of a kind that
 * cannot be sent are turned away first, and said so.
 * @param files - What was picked.
 * @param target - Where they are attached.
 * @param deps - What reading and uploading need.
 * @param say - Told what to show about the batch.
 */
export async function attachFiles(
  files: readonly File[],
  target: AttachTarget,
  deps: AttachDeps,
  say: (notice: AttachNotice) => void,
): Promise<void> {
  const limits = await deps.limits();
  const maxBytes = await deps.maxUploadBytes().catch(() => Infinity);
  const { accepted, notice } = sortPicked(files, maxBytes, deps.newId);
  if (notice) say(notice);
  if (accepted.length === 0) return;

  const outcome = chatAttachments.add(
    target.conversationId,
    accepted.map((a) => a.item),
    limits,
  );
  if (outcome === 'full') {
    say({ key: 'full', limit: limits.maxItems });
    return;
  }
  if (outcome === 'too_long') {
    say({ key: 'tooLong' });
    return;
  }

  const tooLong = await Promise.all(accepted.map((a) => fillIn(a, target, limits, deps)));
  if (tooLong.some(Boolean)) say({ key: 'tooLong' });
}
