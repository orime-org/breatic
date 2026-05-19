import * as React from 'react';

interface TitleEditableProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Project title — inline contenteditable per mock § TopBar v4.0.
 *
 * Always shown as an inline `<span contenteditable>`; clicking inside
 * activates the cursor (no mode toggle). Enter or blur commits;
 * Escape cancels (restore previous text).
 *
 * Behavioral contract:
 *   - Empty / whitespace-only commits are rejected (restore previous).
 *   - Newlines are stripped (single-line title).
 *   - Outer parent of `min-w-0` keeps the title from overflowing.
 */
export function TitleEditable({ value, onChange }: TitleEditableProps) {
  const ref = React.useRef<HTMLSpanElement>(null);

  // Keep the DOM text in sync with the prop when external rename happens
  // and the user isn't currently editing.
  React.useEffect(() => {
    if (ref.current && ref.current.innerText !== value) {
      ref.current.innerText = value;
    }
  }, [value]);

  const commit = () => {
    if (!ref.current) return;
    const next = ref.current.innerText.replace(/\n/g, '').trim();
    if (next.length === 0) {
      ref.current.innerText = value;
      return;
    }
    if (next !== value) onChange(next);
  };

  return (
    <span
      ref={ref}
      role='textbox'
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.currentTarget as HTMLSpanElement).blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          if (ref.current) ref.current.innerText = value;
          (e.currentTarget as HTMLSpanElement).blur();
        }
      }}
      className='min-w-0 truncate text-[13px] font-medium outline-none focus:bg-muted/50'
      style={{ padding: '2px var(--space-2)', borderRadius: 'var(--radius-chrome)' }}
      data-testid='title-display'
    >
      {value}
    </span>
  );
}
