import * as React from 'react';

interface TitleEditableProps {
  value: string;
  onChange: (next: string) => void;
}

/** Project title length cap — system-wide limit, enforced on backend too. */
const MAX_TITLE_LEN = 80;
/** Visible width cap (= Agent column width). Both modes share this. */
const TITLE_MAX_WIDTH = 320;

/**
 * Project title — dual-mode inline title bar element.
 *
 * Two visual modes (transition triggered by focus/blur, no explicit button):
 *
 *   - **Static** (blur)  → `<span>` with `truncate` + ellipsis. Over-long
 *     text is left-aligned and clipped with "…". Width capped at 320px.
 *   - **Edit** (focus)   → `<input>`. Native caret + horizontal scroll
 *     follows the cursor; no ellipsis. Width still capped at 320px.
 *
 * Why dual mode (not `<span contenteditable>`): contenteditable's caret
 * position ignores `overflow:hidden`, so an editing user sees the cursor
 * drift outside the 320 cap. A native `<input>` keeps caret + content in
 * the visible window via horizontal scroll, which is exactly what user
 * expects ("内容从右往左移动 caret 跟随").
 *
 * Commit semantics:
 *   - Enter / blur commit (trim, drop newlines, slice to MAX_TITLE_LEN,
 *     reject empty).
 *   - Escape cancel (restore previous value, exit edit mode).
 */
export function TitleEditable({ value, onChange }: TitleEditableProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Sync draft when external rename happens and we're not actively editing.
  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  // Autofocus the input when we transition into edit mode.
  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.replace(/\n/g, '').trim().slice(0, MAX_TITLE_LEN);
    if (next.length > 0 && next !== value) onChange(next);
    if (next.length === 0) setDraft(value);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const sharedStyle: React.CSSProperties = {
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-chrome)',
    maxWidth: TITLE_MAX_WIDTH,
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={MAX_TITLE_LEN}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className='inline-block min-w-0 border-0 bg-muted/50 align-middle text-[13px] font-medium text-foreground outline-none'
        style={sharedStyle}
        data-testid='title-input'
      />
    );
  }

  return (
    <span
      role='textbox'
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        // Keyboard a11y: Enter or Space starts edit mode.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className='inline-block min-w-0 cursor-text truncate align-middle text-[13px] font-medium outline-none hover:bg-muted/50'
      style={sharedStyle}
      data-testid='title-display'
      title={value}
    >
      {value}
    </span>
  );
}
