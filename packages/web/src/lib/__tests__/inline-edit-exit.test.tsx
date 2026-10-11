// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useInlineEditExit } from '@web/lib/inline-edit-exit';

interface HarnessProps {
  /** Whether the hand-back target is in the page at the moment it is asked for. */
  targetPresent: () => boolean;
  onCommit: () => void;
  onCancel: () => void;
  isolate?: boolean;
}

/**
 * A box that ends editing the way every rename site does: commit and cancel
 * close it, and leaving it closes it too.
 * @param root0 - Harness props.
 * @param root0.targetPresent - Whether the target exists when asked for.
 * @param root0.onCommit - Spy for commits.
 * @param root0.onCancel - Spy for cancels.
 * @param root0.isolate - Passed through to the hook.
 * @returns The harness.
 */
function Harness({
  targetPresent,
  onCommit,
  onCancel,
  isolate,
}: HarnessProps): React.JSX.Element {
  const [editing, setEditing] = React.useState(true);
  const target = React.useRef<HTMLButtonElement>(null);
  const exit = useInlineEditExit({
    editing,
    target: () => (targetPresent() ? target.current : null),
    commit: () => {
      onCommit();
      setEditing(false);
    },
    cancel: () => {
      onCancel();
      setEditing(false);
    },
    isolate,
  });
  return (
    <div>
      {editing ? (
        <input
          data-testid='field'
          ref={(el) => el?.focus()}
          onKeyDown={exit.onKeyDown}
          onCompositionEnd={exit.onCompositionEnd}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <button type='button' data-testid='reopen' onClick={() => setEditing(true)}>
          reopen
        </button>
      )}
      <button type='button' ref={target} data-testid='target'>
        target
      </button>
      <button type='button' data-testid='elsewhere'>
        elsewhere
      </button>
    </div>
  );
}

let removeListener = (): void => {};

/**
 * Renders the harness with spies; `onParentKey` sees the keys that reach the
 * window, where the canvas listens.
 * @param overrides - Props to replace.
 * @returns The spies.
 */
function setup(overrides: Partial<HarnessProps> = {}): {
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  onParentKey: ReturnType<typeof vi.fn>;
} {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const onParentKey = vi.fn();
  window.addEventListener('keydown', onParentKey);
  removeListener = () => window.removeEventListener('keydown', onParentKey);
  render(
    <Harness
      targetPresent={() => true}
      onCommit={onCommit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onCommit, onCancel, onParentKey };
}

afterEach(() => {
  cleanup();
  removeListener();
});

describe('useInlineEditExit', () => {
  it('commits on Enter, consumes the key and hands focus to the target', () => {
    const { onCommit } = setup();
    const field = screen.getByTestId('field');
    expect(document.activeElement).toBe(field);
    const notCancelled = fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 });
    expect(notCancelled).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('field')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('target'));
  });

  it('cancels on Escape, consumes the key and hands focus to the target', () => {
    const { onCancel, onCommit } = setup();
    const notCancelled = fireEvent.keyDown(screen.getByTestId('field'), {
      key: 'Escape',
      keyCode: 27,
    });
    expect(notCancelled).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('target'));
  });

  it('leaves focus where the reader went when editing ends by leaving the box', () => {
    setup();
    const elsewhere = screen.getByTestId('elsewhere');
    act(() => elsewhere.focus());
    expect(screen.queryByTestId('field')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('keeps editing on the Enter that accepts an input method candidate', () => {
    const { onCommit } = setup();
    const field = screen.getByTestId('field');
    fireEvent.compositionEnd(field);
    const notCancelled = fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 });
    expect(notCancelled).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('field')).toBe(field);
    expect(document.activeElement).toBe(field);
  });

  it.each([
    ['while composing', { isComposing: true, keyCode: 27 }],
    ['reported as 229', { keyCode: 229 }],
  ])('keeps editing on an Escape that belongs to the input method (%s)', (_, init) => {
    const { onCancel } = setup();
    const field = screen.getByTestId('field');
    const notCancelled = fireEvent.keyDown(field, { key: 'Escape', ...init });
    expect(notCancelled).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it('keeps editing on an Escape right after a composition ends', () => {
    const { onCancel } = setup();
    const field = screen.getByTestId('field');
    fireEvent.compositionEnd(field);
    const notCancelled = fireEvent.keyDown(field, { key: 'Escape', keyCode: 27 });
    expect(notCancelled).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it('stops every key at the box when isolated', () => {
    const { onParentKey } = setup({ isolate: true });
    const field = screen.getByTestId('field');
    fireEvent.keyDown(field, { key: 'a', keyCode: 65 });
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 });
    expect(onParentKey).not.toHaveBeenCalled();
  });

  it('stops the key that ends the edit at the box when isolated', () => {
    const { onParentKey, onCancel } = setup({ isolate: true });
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Escape', keyCode: 27 });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onParentKey).not.toHaveBeenCalled();
  });

  it('lets other keys reach the window when not isolated', () => {
    const { onParentKey } = setup();
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'a', keyCode: 65 });
    expect(onParentKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Enter', 13],
    ['Escape', 27],
  ])('keeps the held %s from repeating into the target until it is released', (key, keyCode) => {
    setup();
    fireEvent.keyDown(screen.getByTestId('field'), { key, keyCode });
    const target = screen.getByTestId('target');
    expect(document.activeElement).toBe(target);
    const reached = vi.fn();
    target.addEventListener('keydown', reached);

    const notCancelled = fireEvent.keyDown(target, { key, keyCode, repeat: true });
    expect(notCancelled).toBe(false);
    expect(reached).not.toHaveBeenCalled();

    fireEvent.keyUp(target, { key, keyCode });
    fireEvent.keyDown(target, { key, keyCode, repeat: true });
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('lets the held key repeat again once the window loses focus', () => {
    setup();
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter', keyCode: 13 });
    const target = screen.getByTestId('target');
    const reached = vi.fn();
    target.addEventListener('keydown', reached);
    fireEvent.blur(window);
    fireEvent.keyDown(target, { key: 'Enter', keyCode: 13, repeat: true });
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Enter', 13],
    ['Escape', 27],
  ])('consumes a repeated %s at the box without ending the edit', (key, keyCode) => {
    const { onCommit, onCancel } = setup();
    const field = screen.getByTestId('field');
    const notCancelled = fireEvent.keyDown(field, { key, keyCode, repeat: true });
    expect(notCancelled).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('field')).toBe(field);
  });

  it('lets a later hold of the key repeat when the release of the first one never arrived', () => {
    const { onParentKey } = setup();
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter', keyCode: 13 });
    // No keyup: macOS sends none for a key released while Command is held.
    onParentKey.mockClear();
    fireEvent.keyDown(document.body, { key: 'Enter', keyCode: 13 });
    const notCancelled = fireEvent.keyDown(document.body, { key: 'Enter', keyCode: 13, repeat: true });
    expect(notCancelled).toBe(true);
    expect(onParentKey).toHaveBeenCalledTimes(2);
  });

  it('stops holding the key back once the box owner unmounts', () => {
    const { onParentKey } = setup();
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter', keyCode: 13 });
    cleanup();
    onParentKey.mockClear();
    const notCancelled = fireEvent.keyDown(document.body, { key: 'Enter', keyCode: 13, repeat: true });
    expect(notCancelled).toBe(true);
    expect(onParentKey).toHaveBeenCalledTimes(1);
  });

  it('does not carry a missing-target hand-back over to a later edit that ends by leaving', () => {
    let present = false;
    setup({ targetPresent: () => present });
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter', keyCode: 13 });
    expect(document.activeElement).not.toBe(screen.getByTestId('target'));

    present = true;
    fireEvent.click(screen.getByTestId('reopen'));
    const elsewhere = screen.getByTestId('elsewhere');
    act(() => elsewhere.focus());
    expect(screen.queryByTestId('field')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});
