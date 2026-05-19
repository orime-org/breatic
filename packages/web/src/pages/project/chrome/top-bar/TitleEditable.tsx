import * as React from 'react';

import { Input } from '@/components/ui/input';

interface TitleEditableProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Inline-editable project title. Click to enter edit mode, Enter or blur
 * to commit, Escape to cancel. Non-edit mode renders as a static label
 * to keep the chrome calm at rest.
 */
export function TitleEditable({ value, onChange }: TitleEditableProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== value) onChange(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        className='h-7 w-48'
        data-testid='title-input'
      />
    );
  }

  return (
    <button
      type='button'
      onClick={() => setEditing(true)}
      className='truncate rounded px-1 text-sm font-medium hover:bg-muted'
      data-testid='title-display'
    >
      {value}
    </button>
  );
}
