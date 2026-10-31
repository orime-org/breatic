// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { newId } from '@breatic/shared';

import { assetsApi } from '@web/data/api';
import { attachAccept, attachFiles, type AttachDeps } from '@web/pages/project/chat/attach-files';
import { uploadMedia } from '@web/data/upload/media-upload';
import { extractText } from '@web/spaces/canvas/text-extract';
import { openTray } from '@web/stores/attach-to-chat';

/**
 * Upload one file for a chat message.
 *
 * Registered as a byproduct, the way a crop is: it lands in the studio's
 * assets, which is the only way into storage, and makes no row of its own in
 * the project's activity feed.
 * @param file - The file.
 * @param projectId - The project the chat is in.
 * @returns The address it was filed under.
 * @throws {UploadFailedError} When the upload could not complete.
 */
async function uploadForChat(file: File, projectId: string): Promise<string> {
  return (await uploadMedia(file, { projectId, derived: true })).fileUrl;
}

/** The real dependencies. */
const LIVE: AttachDeps = {
  tray: openTray,
  maxUploadBytes: async () => (await assetsApi.fetchUploadConfig()).maxUploadBytes,
  upload: uploadForChat,
  extract: (file) => extractText(file),
  newId,
};

/** What the composer's attach button needs. */
export interface AttachFiles {
  /** Attach the picked files. */
  attach: (files: File[]) => void;
  /** What the file picker offers. */
  accept: string;
}

/**
 * The composer's attach button.
 * @param projectId - The project the chat is in.
 * @returns What the composer needs.
 */
export function useAttachFiles(projectId: string): AttachFiles {

  const attach = React.useCallback(
    (files: File[]): void => {
      void attachFiles(files, projectId, LIVE);
    },
    [projectId],
  );

  const accept = React.useMemo(() => attachAccept(), []);

  return { attach, accept };
}
