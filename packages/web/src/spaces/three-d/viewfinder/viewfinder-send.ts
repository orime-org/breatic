// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { newId } from '@breatic/shared';
import { assetsApi } from '@web/data/api';
import { checkFileAdmission, mediaFormatNotice } from '@web/spaces/canvas/canvas-upload';
import { uploadDerivedImage } from '@web/spaces/canvas/upload-derived-image';
import { openTray, uploadTrayItem } from '@web/stores/attach-to-chat';
import { chatAttachments, type TrayItem } from '@web/stores/chat-attachments';
import { useUIStore } from '@web/stores/ui';

/**
 * Put a capture into the Agent tray the way a picked image is (#1411 design
 * 3.4 and 5.2): bring the chat column into view, open the tray of the
 * conversation on screen, check the file, add it uploading, then upload it as
 * a derived image of this 3D Space. What stopped it is said the way the tray
 * says it.
 * @param where - The project and the 3D Space.
 * @param where.projectId - The project.
 * @param where.spaceId - The 3D Space.
 * @param file - The capture.
 * @returns True when the item turned ready.
 */
export async function sendCaptureToAgent(where: { projectId: string; spaceId: string }, file: File): Promise<boolean> {
  useUIStore.getState().setChatPanelCollapsed(false);
  const tray = await openTray(where.projectId);
  if (!tray) return false;
  const maxBytes = await assetsApi.fetchUploadConfig().then((config) => config.maxUploadBytes, () => Infinity);
  const rejection = checkFileAdmission(file, maxBytes);
  if (rejection !== null) {
    chatAttachments.say(rejection === 'tooLarge' ? { key: 'tooLarge', filename: file.name }
      : rejection === 'unsupportedType' ? mediaFormatNotice(file) : { key: 'unsupported', filename: file.name });
    return false;
  }
  const item: TrayItem = { id: newId(), name: file.name, type: 'image', status: 'uploading' };
  if (chatAttachments.add(tray.conversationId, [item], tray.limits) !== 'added') return false;
  const outcome = await uploadTrayItem(tray, item, file, (f) => uploadDerivedImage(f, where));
  if (outcome === 'unsupported') chatAttachments.say(mediaFormatNotice(file));
  return outcome === 'ready';
}

/**
 * Write a capture to the clipboard as a PNG.
 * @param blob - The PNG.
 * @returns True when the browser took it.
 */
export async function copyCapture(blob: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
