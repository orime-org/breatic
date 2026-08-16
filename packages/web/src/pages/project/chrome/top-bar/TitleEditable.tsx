// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

interface TitleEditableProps {
  value: string;
  onChange: (next: string) => void;
  /**
   * Visible width cap (px). Defaults to 320 (= Agent column width) for
   * the TopBar project title; callers in tighter containers (e.g. Agent
   * column header sharing 40px row with icons + chip + button) should
   * pass a smaller value so truncation kicks in at the right boundary.
   */
  maxWidth?: number;
  /**
   * How many characters the name may run to.
   *
   * Defaults to what a project name may hold, which is what this box was
   * written for. A caller whose thing is stored with a different limit passes
   * its own -- otherwise opening this box and closing it again would shorten
   * a name that is perfectly legal where it lives, without the reader having
   * changed a thing.
   */
  maxLength?: number;
  /**
   * What to show while the thing has no name of its own.
   *
   * A stand-in, not a name: it is drawn in place of an empty value and it goes
   * in the box's `placeholder`, so opening the box shows an empty field rather
   * than pre-filling the words on screen. Passing it as `value` instead makes
   * the stand-in indistinguishable from a name -- typing exactly those words
   * then reads as "nothing changed" and the rename is dropped, with nothing on
   * screen moving to say so.
   */
  placeholder?: string;
  /**
   * Whether the title is editable (default true). When false the title is
   * a plain read-only span — no double-click-to-edit, no keyboard edit
   * affordance, not exposed as a focusable textbox. Used to gate the
   * project rename for non-owner roles (viewer); the backend `requireRole`
   * is the real enforcement, this is UX only.
   */
  editable?: boolean;
}

/**
 * How long a name may be when the caller does not say.
 *
 * Project names, which is what this box was written for. A caller whose thing
 * is stored with a different limit has to pass its own -- otherwise opening
 * this box and closing it again would quietly shorten a name that was
 * perfectly legal where it lives.
 */
const DEFAULT_MAX_TITLE_LEN = 80;
/** Default visible width cap when caller doesn't override. */
const DEFAULT_TITLE_MAX_WIDTH = 320;

/**
 * Project title — dual-mode inline title bar element.
 *
 * Two visual modes:
 *
 *   - **Static**         → `<span>` with `truncate` + ellipsis. Over-long
 *     text is left-aligned and clipped with "…". Width capped at 320px.
 *   - **Edit** (focus)   → `<input>`. Native caret + horizontal scroll
 *     follows the cursor; no ellipsis. Width still capped at 320px.
 *
 * Edit trigger (2026-05-25, PR #140): **double-click** the static span
 * enters edit mode. Single-click does nothing — consistent with the
 * inline rename rule across the app (SpaceTab name, etc.). Keyboard
 * a11y is preserved: Enter / Space on the focused span still enters
 * edit so keyboard-only users aren't locked out.
 *
 * Why double-click (not single-click): a single-click on the chrome
 * title is a common cursor-park gesture; making single-click toggle
 * edit produces accidental rename mode whenever the user clicks the
 * title bar.
 *
 * Why dual mode (not `<span contenteditable>`): contenteditable's caret
 * position ignores `overflow:hidden`, so an editing user sees the cursor
 * drift outside the 320 cap. A native `<input>` keeps caret + content in
 * the visible window via horizontal scroll, which is exactly what user
 * expects (content scrolls right-to-left while the caret stays put).
 *
 * Commit semantics:
 *   - Enter / blur commit (trim, drop newlines, slice to the length cap,
 *     reject empty).
 *   - Escape cancel (restore previous value, exit edit mode).
 * @param root0 - Editable title props.
 * @param root0.value - Current project title shown in static mode and seeded as the edit draft.
 * @param root0.onChange - Called with the trimmed, length-capped new title once the user commits a rename.
 * @param root0.maxWidth - Visible width cap in pixels; defaults to the Agent column width.
 * @param root0.maxLength - How many characters the name may run to; defaults to what a project name may hold.
 * @param root0.placeholder - What to show while the thing has no name of its own.
 * @param root0.editable - Whether the title can be edited; defaults to true. When false the span is read-only.
 * @returns the static truncated title span, or the editing input while in edit mode.
 */
export function TitleEditable({
  value,
  onChange,
  maxWidth = DEFAULT_TITLE_MAX_WIDTH,
  maxLength = DEFAULT_MAX_TITLE_LEN,
  placeholder,
  editable = true,
}: TitleEditableProps): React.JSX.Element {
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

  /**
   * Commits the draft as the new title — normalizes whitespace, caps length,
   * fires `onChange` when changed and non-empty, and leaves edit mode.
   */
  const commit = (): void => {
    const next = draft.replace(/\n/g, '').trim().slice(0, maxLength);
    if (next.length > 0 && next !== value) onChange(next);
    if (next.length === 0) setDraft(value);
    setEditing(false);
  };

  /**
   * Cancels the edit — restores the draft to the current value and leaves edit mode.
   */
  const cancel = (): void => {
    setDraft(value);
    setEditing(false);
  };

  // What the static span reads. `draft` is the name, and while there is none
  // the stand-in takes its place on screen -- without ever becoming the value
  // the box opens with or the one a commit is compared against.
  const shown = draft.length > 0 ? draft : (placeholder ?? '');

  const sharedStyle: React.CSSProperties = {
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-chrome)',
    maxWidth,
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        placeholder={placeholder}
        maxLength={maxLength}
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
        // `field-sizing: content` (2024 CSS spec, Chrome 123+ / FF 137+ /
        // Safari 18.4+) makes the input width follow the content length up
        // to max-width — matching the span's inline-block content-grow
        // behaviour so the static/edit transition has no width jump.
        //
        // Background: `bg-muted` (solid token) so dark mode shows the dark
        // stone-warm value — `bg-muted/50` opacity modifier fell back to
        // browser-native input white in dark mode (Tailwind 4 + var color
        // alpha quirk). Solid token keeps the contrast right both modes.
        className='inline-block min-w-[40px] border-0 bg-muted align-middle text-sm font-medium text-foreground outline-none [field-sizing:content]'
        style={sharedStyle}
        data-testid='title-input'
      />
    );
  }

  // Read-only mode (editable=false): a plain truncating span with no edit
  // affordance — not a focusable textbox, no double-click / Enter / Space
  // edit trigger, no hover background. Used to gate the project rename for
  // non-owner roles; the backend `requireRole` is the real enforcement.
  if (!editable) {
    return (
      <span
        className='inline-block min-w-0 truncate align-middle text-sm font-medium'
        style={sharedStyle}
        data-testid='title-display'
        title={shown}
      >
        {shown}
      </span>
    );
  }

  // Render `draft` (not `value`) so the optimistic title is visible
  // immediately on commit — the parent's optimistic cache write goes
  // through a microtask (onMutate awaits cancelQueries), so reading
  // `value` here would briefly show the stale name for one frame.
  // The useEffect above keeps `draft === value` whenever editing is
  // false, so rollback on failure still flows back through `draft`.
  return (
    <span
      role='textbox'
      tabIndex={0}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(e) => {
        // Keyboard a11y: Enter or Space starts edit mode (no double-
        // key needed — keyboard users couldn't double-click anyway).
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className='inline-block min-w-0 cursor-text truncate align-middle text-sm font-medium outline-none hover:bg-accent'
      style={sharedStyle}
      data-testid='title-display'
      title={shown}
    >
      {shown}
    </span>
  );
}
