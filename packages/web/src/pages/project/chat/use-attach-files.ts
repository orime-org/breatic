// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { newId } from '@breatic/shared';

import { assetsApi } from '@web/data/api';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import { useTranslation } from '@web/i18n/use-translation';
import { attachAccept, attachFiles, type AttachDeps } from '@web/pages/project/chat/attach-files';
import { runMediaUpload } from '@web/spaces/canvas/canvas-upload';
import { extractText } from '@web/spaces/canvas/text-extract';
import { openTray } from '@web/stores/attach-to-chat';
import { useTrayNotice, type TrayNotice } from '@web/stores/chat-attachments';

/**
 * Upload one file for a chat message.
 *
 * Registered as a byproduct, the way a crop is: it lands in the studio's
 * assets, which is the only way into storage, and makes no row of its own in
 * the project's activity feed.
 * @param file - The file.
 * @param projectId - The project the chat is in.
 * @returns The address it was filed under, when the server said.
 * @throws {Error} When the upload could not complete.
 */
function uploadForChat(file: File, projectId: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    void runMediaUpload(
      file,
      { projectId, derived: true },
      {
        getUploadConfig: assetsApi.fetchUploadConfig,
        hashFile,
        requestTicket: assetsApi.requestUploadTicket,
        sendToIngest: sendFileAndFinish,
        onSuccess: ({ fileUrl }) => resolve(fileUrl),
        onFailure: (outcome) => reject(new Error(outcome.reason)),
      },
    );
  });
}

/**
 * What the reader is told about their last attempt to attach something.
 * @param said - What the tray said.
 * @param t - The translator.
 * @returns The sentence.
 */
function noticeText(said: TrayNotice, t: ReturnType<typeof useTranslation>): string {
  switch (said.key) {
    case 'unavailable':
      return t('chat.composer.attachUnavailable');
    case 'full':
      return t('chat.composer.attachFull', { limit: said.limit });
    case 'tooLong':
      return t('chat.composer.attachTooLong');
    case 'tooLarge':
      return t('chat.composer.attachTooLarge', { filename: said.filename });
    case 'unsupported':
      return t('chat.composer.attachUnsupported', { filename: said.filename });
  }
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
  /** What to say about the last attempt, if anything. */
  notice: string | undefined;
}

/**
 * The composer's attach button.
 * @param projectId - The project the chat is in.
 * @param conversationId - The conversation on screen, whose notice is shown.
 * @returns What the composer needs.
 */
export function useAttachFiles(projectId: string, conversationId: string | undefined): AttachFiles {
  const t = useTranslation();
  const said = useTrayNotice(conversationId);

  const attach = React.useCallback(
    (files: File[]): void => {
      void attachFiles(files, projectId, LIVE);
    },
    [projectId],
  );

  const accept = React.useMemo(() => attachAccept(), []);

  // Worked out on every render: `t` keeps one identity across a language
  // switch, so a memo on it would keep the first language. A string compares
  // by value, so the composer's memo still holds.
  const notice = said === null ? undefined : noticeText(said, t);

  return { attach, accept, notice };
}
