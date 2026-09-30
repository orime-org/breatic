// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from '@breatic/shared';

import {
  checkFileAdmission,
  fileToNodeSpec,
  uploadAcceptFor,
  type UploadNodeSpec,
} from '@web/spaces/canvas/canvas-upload';
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
 * The most UTF-8 bytes one UTF-16 code unit (what `string.length` counts)
 * can take. A text file larger than this many bytes per allowed character
 * cannot fit, whatever it says.
 */
const MAX_BYTES_PER_CHAR = 3;

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

/** A file that will be attached. */
interface Accepted {
  file: File;
  item: TrayItem;
}

/**
 * What a picked file is sent as, or why it is turned away before it is read
 * or uploaded.
 * @param file - The file.
 * @param maxBytes - The largest file that may be uploaded.
 * @param limits - The limits the list is held to.
 * @returns What it is sent as, or what to say about it.
 */
function classify(
  file: File,
  maxBytes: number,
  limits: AttachmentLimits,
): { as: UploadNodeSpec['nodeType'] } | { refused: TrayNotice } {
  const { nodeType, needsUpload } = fileToNodeSpec(file);
  const extractor = needsUpload ? null : pickExtractor(file.type);
  if (!needsUpload && extractor === null) return { refused: { key: 'unsupported', filename: file.name } };
  const rejection = checkFileAdmission(file, maxBytes);
  if (rejection === 'tooLarge') return { refused: { key: 'tooLarge', filename: file.name } };
  if (rejection !== null) return { refused: { key: 'unsupported', filename: file.name } };
  if (extractor === 'text' && file.size > limits.maxChars * MAX_BYTES_PER_CHAR) {
    return { refused: { key: 'tooLong' } };
  }
  return { as: nodeType };
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
    const sorted = classify(file, maxBytes, limits);
    if ('refused' in sorted) {
      notice ??= sorted.refused;
      continue;
    }
    accepted.push({
      file,
      item: { id: newId(), name: file.name, type: sorted.as, status: 'uploading' },
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
  const { file, item } = picked;
  const media = item.type !== 'text';
  const base = { id: item.id, type: item.type, name: item.name };
  let chip: ChatAttachedChip;
  try {
    if (media) {
      const url = await deps.upload(file, projectId);
      if (url === undefined) throw new Error('upload answered no address');
      chip = { ...base, data_snapshot: { url } };
    } else {
      const text = await deps.extract(file);
      // A scanned pdf has no text layer: nothing to hand the agent.
      if (text.trim() === '') throw new Error('document holds no words');
      chip = { ...base, data_snapshot: { text } };
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
