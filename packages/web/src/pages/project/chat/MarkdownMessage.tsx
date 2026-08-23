// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Assistant prose, rendered as markdown.
 */
import type { ReactElement } from 'react';

interface MarkdownMessageProps {
  /** The assistant's prose, as markdown. */
  content: string;
  /** Whether this turn is still receiving tokens. */
  streaming?: boolean;
}

/**
 * Draw one assistant message.
 * @param root0 - The component props.
 * @param root0.content - The assistant's prose, as markdown.
 * @param root0.streaming - Whether this turn is still receiving tokens.
 * @returns The rendered prose.
 */
export function MarkdownMessage({
  content,
  streaming = false,
}: MarkdownMessageProps): ReactElement {
  return (
    <div
      className='chat-markdown text-sm'
      data-streaming={streaming ? 'true' : undefined}
      data-testid='markdown-body'
    >
      {content}
    </div>
  );
}
