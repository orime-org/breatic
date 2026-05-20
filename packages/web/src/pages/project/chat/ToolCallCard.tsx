import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { ToolCall } from '@/pages/project/chat/types';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

/**
 * Compact card embedded inside an assistant bubble showing the agent's
 * tool call: name, status icon, and (on success) a small JSON preview.
 * Argument/result detail expansion lands in a later polish PR.
 */
export function ToolCallCard({ toolCall }: ToolCallCardProps) {
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

function StatusIcon({ status }: { status: ToolCall['status'] }) {
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
