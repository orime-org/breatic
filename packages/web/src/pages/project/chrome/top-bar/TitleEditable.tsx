// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useInlineEditExit } from '@web/lib/inline-edit-exit';
import { useHeldName } from '@web/lib/use-held-name';

interface TitleEditableProps {
  value: string;
  /**
   * Saves a committed rename. The box shows the committed name until `value`
   * changes; a returned promise that rejects puts `value` back on screen.
   */
  onChange: (next: string) => void | Promise<unknown>;
  /**
   * Visible width cap (px). Defaults to 320, which is what the Agent column
   * was fixed at when this box was written; the column can now be dragged
   * between 320 and 640, so the default no longer stands for anything but the
   * TopBar project title's own cap. Callers in tighter containers (e.g. the
   * Agent column header, where the title shares a 40px row with two icon
   * buttons) pass a smaller value so truncation kicks in at the right
   * boundary.
   */
  maxWidth?: number;
  /**
   * How many characters the name may run to: the limit of wherever the
   * caller stores it. A smaller number would shorten a legal name the moment
   * the box was opened and closed, without the reader having changed a thing.
   */
  maxLength: number;
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
   * affordance, not exposed as a focusable textbox. The project page passes
   * `canManageMeta`; the server's `assertMayManage` is the real
   * enforcement, this is UX only.
   */
  editable?: boolean;
}

/** Default visible width cap when caller doesn't override. */
const DEFAULT_TITLE_MAX_WIDTH = 320;

/**
 * Project title — dual-mode inline title bar element.
 *
 * Two visual modes:
 *
 *   - **Static**         → `<span>` with `truncate` + ellipsis. Over-long
 *     text is left-aligned and clipped with "…". Width capped at `maxWidth`.
 *   - **Edit** (focus)   → `<input>`. Native caret + horizontal scroll
 *     follows the cursor; no ellipsis. Width still capped at `maxWidth`.
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
 * drift outside the width cap. A native `<input>` keeps caret + content in
 * the visible window via horizontal scroll, which is exactly what user
 * expects (content scrolls right-to-left while the caret stays put).
 *
 * Commit semantics:
 *   - Enter / blur commit (trim, drop newlines, slice to the length cap,
 *     reject empty).
 *   - Escape cancel (restore previous value, exit edit mode).
 *   - Ending from the keyboard gives the keyboard back to the title; keys
 *     that belong to an input method end nothing.
 * @param root0 - Editable title props.
 * @param root0.value - Current project title shown in static mode and seeded as the edit draft.
 * @param root0.onChange - Called with the trimmed, length-capped new title once the user commits a rename.
 * @param root0.maxWidth - Visible width cap in pixels; defaults to 320.
 * @param root0.maxLength - How many characters the name may run to, as the caller stores it.
 * @param root0.placeholder - What to show while the thing has no name of its own.
 * @param root0.editable - Whether the title can be edited; defaults to true. When false the span is read-only.
 * @returns the static truncated title span, or the editing input while in edit mode.
 */
export function TitleEditable({
  value,
  onChange,
  maxWidth = DEFAULT_TITLE_MAX_WIDTH,
  maxLength,
  placeholder,
  editable = true,
}: TitleEditableProps): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // The caller's `value` catches up with a commit a render or a request later.
  const { shown: name, hold } = useHeldName(value);

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
    if (next.length > 0 && next !== name) hold(next, onChange(next));
    setEditing(false);
  };

  /**
   * Cancels the edit and leaves edit mode.
   */
  const cancel = (): void => {
    setEditing(false);
  };

  /**
   * Opens the box on the name as it is shown.
   */
  const startEdit = (): void => {
    setDraft(name);
    setEditing(true);
  };

  // Ending the edit from the keyboard gives the keyboard back to the title.
  const display = React.useRef<HTMLSpanElement>(null);
  const exit = useInlineEditExit({
    editing,
    target: () => display.current,
    commit,
    cancel,
  });

  // What the static span reads. While there is no name the stand-in takes its
  // place on screen -- without ever becoming the value the box opens with or
  // the one a commit is compared against.
  const shown = name.length > 0 ? name : (placeholder ?? '');

  const sharedStyle: React.CSSProperties = {
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-chrome)',
    maxWidth,
  };

  if (editing) {
    return (
      <input
        autoComplete='off'
        ref={inputRef}
        value={draft}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={exit.onKeyDown}
        onCompositionEnd={exit.onCompositionEnd}
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
  // edit trigger, no hover background.
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

  return (
    <span
      ref={display}
      role='textbox'
      tabIndex={0}
      onDoubleClick={startEdit}
      onKeyDown={(e) => {
        // Keyboard a11y: Enter or Space starts edit mode (no double-
        // key needed — keyboard users couldn't double-click anyway).
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          startEdit();
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
