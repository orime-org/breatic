// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from '@breatic/shared';

import { checkFileAdmission, uploadAcceptFor } from '@web/spaces/canvas/canvas-upload';
import { pickExtractor } from '@web/spaces/canvas/text-extract';
import type { Tray } from '@web/stores/attach-to-chat';
import {
  chatAttachments,
  type AttachmentLimits,
  type TrayItem,
  type TrayNotice,
} from '@web/stores/chat-attachments';

/** What attaching needs from outside. Injected so it can be exercised alone. */
export interface AttachDeps {
  /** Where the files land, and the limits they are held to. */
  tray: (projectId: string) => Promise<Tray | undefined>;
  /** The largest file that may be uploaded, in bytes. */
  maxUploadBytes: () => Promise<number>;
  /** Upload a media file, answering the address it was filed under. */
  upload: (file: File, projectId: string) => Promise<string | undefined>;
  /** Read a document's text. */
  extract: (file: File) => Promise<string>;
  /** A fresh id for an item that has no canvas node behind it. */
  newId: () => string;
}

/**
 * The most bytes one character of text can take in UTF-8. A text file larger
 * than this many bytes per allowed character cannot fit, whatever it says.
 */
const MAX_BYTES_PER_CHAR = 3;

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
 * Why a picked file is turned away before it is read or uploaded.
 * @param file - The file.
 * @param maxBytes - The largest file that may be uploaded.
 * @param limits - The limits the list is held to.
 * @returns What to say about it, or null to take it.
 */
function turnedAway(file: File, maxBytes: number, limits: AttachmentLimits): TrayNotice | null {
  const kind = mediaKindOf(file);
  const extractor = kind === null ? pickExtractor(file.type) : null;
  if (kind === null && extractor === null) return { key: 'unsupported', filename: file.name };
  const rejection = checkFileAdmission(file, maxBytes);
  if (rejection === 'tooLarge') return { key: 'tooLarge', filename: file.name };
  if (rejection !== null) return { key: 'unsupported', filename: file.name };
  if (extractor === 'text' && file.size > limits.maxChars * MAX_BYTES_PER_CHAR) return { key: 'tooLong' };
  return null;
}

/**
 * Sort the picked files into what will be attached and what is turned away.
 * @param files - What was picked.
 * @param maxBytes - The largest file that may be uploaded.
 * @param limits - The limits the list is held to.
 * @param newId - Makes an id for each accepted file.
 * @returns The accepted files, and the first thing to say about the rest.
 */
function sortPicked(
  files: readonly File[],
  maxBytes: number,
  limits: AttachmentLimits,
  newId: () => string,
): { accepted: Accepted[]; notice: TrayNotice | null } {
  const accepted: Accepted[] = [];
  let notice: TrayNotice | null = null;
  for (const file of files) {
    const refused = turnedAway(file, maxBytes, limits);
    if (refused !== null) {
      notice ??= refused;
      continue;
    }
    const kind = mediaKindOf(file);
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
 * @param tray - Where it is attached.
 * @param projectId - The project media is uploaded into.
 * @param deps - What reading and uploading need.
 */
async function fillIn(picked: Accepted, tray: Tray, projectId: string, deps: AttachDeps): Promise<void> {
  const { file, item, media } = picked;
  const base = { id: item.id, type: item.type, name: item.name };
  let chip: ChatAttachedChip;
  try {
    if (media) {
      const url = await deps.upload(file, projectId);
      if (url === undefined) throw new Error('upload answered no address');
      chip = { ...base, data_snapshot: { url } };
    } else {
      chip = { ...base, data_snapshot: { text: await deps.extract(file) } };
    }
  } catch {
    // The item says it failed, which is what the reader acts on: take it out
    // and pick the file again.
    chatAttachments.fail(tray.conversationId, item.id, media ? 'upload' : 'extract');
    return;
  }
  chatAttachments.settle(tray.conversationId, item.id, chip, tray.limits);
}

/**
 * Attach the files a reader picked.
 *
 * They land above the box of the conversation on screen, opened first when
 * there is none. Files of a kind that cannot be sent, or too big to fit, are
 * turned away first and said so. The rest go in whole or not at all, each
 * uploading; then each is uploaded or read on its own and turns ready or
 * failed.
 * @param files - What was picked.
 * @param projectId - The project the chat is in.
 * @param deps - What reading and uploading need.
 */
export async function attachFiles(
  files: readonly File[],
  projectId: string,
  deps: AttachDeps,
): Promise<void> {
  const tray = await deps.tray(projectId);
  if (!tray) return;
  const maxBytes = await deps.maxUploadBytes().catch(() => Infinity);
  const { accepted, notice } = sortPicked(files, maxBytes, tray.limits, deps.newId);
  if (notice) chatAttachments.say(tray.conversationId, notice);
  if (accepted.length === 0) return;
  const outcome = chatAttachments.add(
    tray.conversationId,
    accepted.map((a) => a.item),
    tray.limits,
  );
  if (outcome !== 'added') return;
  await Promise.all(accepted.map((a) => fillIn(a, tray, projectId, deps)));
}
