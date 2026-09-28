// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { newId } from '@breatic/shared';

import { assetsApi } from '@web/data/api';
import { chatApi } from '@web/data/api/chat';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import { useTranslation } from '@web/i18n/use-translation';
import {
  attachAccept,
  attachFiles,
  type AttachDeps,
  type AttachNotice,
} from '@web/pages/project/chat/attach-files';
import { runMediaUpload } from '@web/spaces/canvas/canvas-upload';
import { extractText } from '@web/spaces/canvas/text-extract';

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
        onSuccess: resolve,
        onFailure: (outcome) => reject(new Error(outcome.reason)),
      },
    );
  });
}

/** The real dependencies. */
const LIVE: AttachDeps = {
  limits: async () => {
    const config = await chatApi.streamConfig();
    return { maxItems: config.attachmentMaxItems, maxChars: config.attachmentMaxChars };
  },
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
 * The composer's attach button, bound to one conversation.
 * @param projectId - The project the chat is in.
 * @param conversationId - The conversation on screen, if one is.
 * @returns What the composer needs.
 */
export function useAttachFiles(projectId: string, conversationId: string | undefined): AttachFiles {
  const t = useTranslation();
  const [said, setSaid] = React.useState<AttachNotice | 'unavailable' | null>(null);

  // What was said about one conversation is not about the next.
  React.useEffect(() => setSaid(null), [conversationId]);

  const attach = React.useCallback(
    (files: File[]): void => {
      if (conversationId === undefined) return;
      setSaid(null);
      // The limits could not be read, so nothing was attached.
      void attachFiles(files, { conversationId, projectId }, LIVE, setSaid).catch(() =>
        setSaid('unavailable'),
      );
    },
    [conversationId, projectId],
  );

  const accept = React.useMemo(() => attachAccept(), []);

  const notice = React.useMemo((): string | undefined => {
    if (said === null) return undefined;
    if (said === 'unavailable') return t('chat.composer.attachUnavailable');
    if (said.key === 'full') return t('chat.composer.attachFull', { limit: said.limit });
    if (said.key === 'tooLong') return t('chat.composer.attachTooLong');
    if (said.key === 'tooLarge') return t('chat.composer.attachTooLarge', { filename: said.filename });
    return t('chat.composer.attachUnsupported', { filename: said.filename });
  }, [said, t]);

  return { attach, accept, notice };
}
