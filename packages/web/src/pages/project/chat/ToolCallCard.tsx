// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@web/lib/utils';

import type { ToolCall } from '@web/pages/project/chat/types';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

/**
 * Compact card embedded inside an assistant bubble showing the agent's
 * tool call: name, status icon, and (on success) a small JSON preview.
 * Argument/result detail expansion lands in a later polish PR.
 * @param root0 - The component props.
 * @param root0.toolCall - The tool call to render (name, status, optional error).
 * @returns The compact tool-call card.
 */
export function ToolCallCard({
  toolCall,
}: ToolCallCardProps): React.JSX.Element {
  return (
    <div
      data-testid='tool-call-card'
      data-status={toolCall.status}
      className='mt-2 rounded border border-border bg-background/60 px-2 py-1 text-xs'
    >
      <div className='flex items-center gap-1'>
        <StatusIcon status={toolCall.status} />
        <span className='font-mono'>{toolCall.name}</span>
      </div>
      {toolCall.status === 'error' ? (
        <div
          className='mt-1 text-destructive'
          data-testid='tool-call-error'
        >
          {toolCall.errorMessage ?? 'Tool call failed'}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Status icon for a tool call - spinner (pending), check (success), or
 * alert (error).
 * @param root0 - The component props.
 * @param root0.status - The tool call status to map to an icon.
 * @returns The icon element for the given status.
 */
function StatusIcon({
  status,
}: {
  status: ToolCall['status'];
}): React.JSX.Element {
  const cls = 'h-3 w-3';
  switch (status) {
    case 'pending':
      return <Loader2 className={cn(cls, 'animate-spin opacity-70')} />;
    case 'success':
      return <CircleCheck className={cn(cls, 'text-status-success')} />;
    case 'error':
      return <CircleAlert className={cn(cls, 'text-status-error')} />;
  }
}
