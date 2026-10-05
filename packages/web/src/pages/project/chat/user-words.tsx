// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { resolvedSegments, type ChatAttachedChip } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { AttachmentHover, AttachmentKindIcon } from '@web/pages/project/chat/AttachmentChip';
import { attachmentLabel } from '@web/pages/project/chat/attachment-label';
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
      {resolvedSegments(attachments ?? [], content).map((segment, i) => {
        if (segment.kind !== 'reference') {
          return <React.Fragment key={i}>{segment.kind === 'text' ? segment.text : segment.marker}</React.Fragment>;
        }
        const label = attachmentLabel(t, segment.chip);
        return (
          <AttachmentHover key={i} chip={segment.chip} name={label}>
            {/* Selectable and laid out inline, unlike the box's block: a
                selection copied from the history carries the name on its line,
                as the copy button's does. A flex block would put its parts on
                lines of their own in the copied text. */}
            <span
              data-testid='message-reference'
              className={cn(REFERENCE_BLOCK_CLASS, 'inline-block select-text whitespace-nowrap align-[-4.25px] leading-4')}
            >
              <span className='mr-1 inline-block align-[-1.5px]'>
                <AttachmentKindIcon type={segment.chip.type} />
              </span>
              {label}
            </span>
          </AttachmentHover>
        );
      })}
    </span>
  );
}
