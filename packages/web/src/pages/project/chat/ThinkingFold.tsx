import { ChevronDown, ChevronRight } from 'lucide-react';
import * as React from 'react';

interface ThinkingFoldProps {
  thinking: string;
}

/**
 * Foldable "thinking" block shown inside an assistant bubble. Collapsed
 * by default; expansion is a per-bubble UI affordance — the thinking
 * payload is never sent back to the LLM (see CLAUDE.md turn compression
 * notes).
 */
export function ThinkingFold({ thinking }: ThinkingFoldProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <div
      data-testid='thinking-fold'
      className='mb-2 rounded border border-border bg-background/50 text-xs'
    >
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex w-full items-center gap-1 px-2 py-1 text-muted-foreground hover:bg-muted/50'
        aria-expanded={open}
        data-testid='thinking-fold-toggle'
      >
        {open ? (
          <ChevronDown className='h-3 w-3' />
        ) : (
          <ChevronRight className='h-3 w-3' />
        )}
        Thinking
      </button>
      {open ? (
        <pre
          data-testid='thinking-fold-body'
          className='whitespace-pre-wrap px-2 py-1 font-sans text-[11px] text-muted-foreground'
        >
          {thinking}
        </pre>
      ) : null}
    </div>
  );
}
