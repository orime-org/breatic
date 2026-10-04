// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { ChatAttachedChip } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { attachmentLabel, resolvedSegments } from '@web/pages/project/chat/attachment-label';
import { REFERENCE_BLOCK_CLASS } from '@web/pages/project/chat/chat-reference';

interface UserWordsProps {
  /** What the reader typed, references written as markers. */
  content: string;
  /** What the message carried. */
  attachments: readonly ChatAttachedChip[] | undefined;
}

/**
 * What the reader typed, as they typed it: plain characters, with each
 * reference to one of this message's attachments drawn as the block it was
 * in the box. A marker for anything else is shown as the text it is.
 * @param root0 - Component props.
 * @param root0.content - What the reader typed.
 * @param root0.attachments - What the message carried.
 * @returns The words.
 */
export function UserWords({ content, attachments }: UserWordsProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <span className='whitespace-pre-wrap break-words'>
      {resolvedSegments(content, attachments).map((segment, i) =>
        segment.kind === 'reference' ? (
          <span key={i} data-testid='message-reference' className={REFERENCE_BLOCK_CLASS}>
            <span className='truncate'>{attachmentLabel(t, segment.chip)}</span>
          </span>
        ) : (
          <React.Fragment key={i}>{segment.kind === 'text' ? segment.text : segment.marker}</React.Fragment>
        ),
      )}
    </span>
  );
}
