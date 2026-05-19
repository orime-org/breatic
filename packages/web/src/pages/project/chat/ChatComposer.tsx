import { Send, Square } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ChatComposerProps {
  draft: string;
  streaming?: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
}

/**
 * Bottom-of-panel chat composer. Enter submits, Shift+Enter inserts a
 * newline. While the assistant is streaming, the send button swaps to
 * an Abort button so users can stop runaway responses.
 */
export function ChatComposer({
  draft,
  streaming,
  onChange,
  onSubmit,
  onAbort,
}: ChatComposerProps) {
  const submit = () => {
    if (draft.trim().length === 0 || streaming) return;
    onSubmit();
  };

  return (
    <div
      data-testid='chat-composer'
      className='flex items-end gap-2 border-t border-border p-2'
    >
      <Textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder='Message the agent…'
        rows={2}
        className='resize-none'
        data-testid='chat-composer-textarea'
      />
      {streaming ? (
        <Button
          variant='destructive'
          size='icon'
          aria-label='Abort'
          onClick={onAbort}
          data-testid='chat-composer-abort'
        >
          <Square className='h-4 w-4' />
        </Button>
      ) : (
        <Button
          size='icon'
          aria-label='Send'
          disabled={draft.trim().length === 0}
          onClick={submit}
          data-testid='chat-composer-send'
        >
          <Send className='h-4 w-4' />
        </Button>
      )}
    </div>
  );
}
