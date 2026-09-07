// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';

import type { ToolCall } from '@web/pages/project/chat/types';

/**
 * The sentence shown while a tool runs, when the tool has one to give.
 *
 * The key travels on the call itself: the tool declares it in the SDK's
 * `metadata`, which reaches the panel as `toolMetadata` on the part. A table
 * of tool names kept here instead would be a second list to hold true as
 * tools are added, and this package cannot import the one they are declared
 * in.
 * @param call - The call in flight.
 * @param t - The translator.
 * @returns The sentence.
 */
function sentenceFor(
  call: ToolCall,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const query =
    typeof call.args === 'object' && typeof call.args.query === 'string' ? call.args.query : '';
  if (call.runningLine !== undefined) return t(call.runningLine, { query });
  // Nothing declared, so the tool's own identifier is what there is to say.
  // It stays English in every language: it is a name in the code, like the
  // product nouns the glossary freezes, and translating it would name
  // something no log or error message ever mentions.
  return t('chat.tool.running', { tool: call.name });
}

interface ToolRunLineProps {
  /** The call whose sentence is showing. */
  call: ToolCall;
}

/**
 * What a turn is doing right now, on one line with the waiting mark.
 *
 * One line for the whole turn, however many tools are running: it says the
 * turn is busy, and a stack of them would turn that into a log. Which call it
 * names is settled by the caller -- the newest one that has not finished.
 *
 * It lives only while the turn runs. Nothing about it is stored, so a reload
 * shows the answer and no trace of how it was assembled.
 * @param root0 - The component props.
 * @param root0.call - The call whose sentence is showing.
 * @returns The line.
 */
export const ToolRunLine = React.memo(function ToolRunLine({
  call,
}: ToolRunLineProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='tool-run-line'
      className='mt-[0.85em] flex items-center gap-2 text-xs text-muted-foreground'
    >
      <span>{sentenceFor(call, t)}</span>
      <span aria-label={t('chat.message.waiting')} className='chat-waiting-dot' role='status' />
    </div>
  );
});
