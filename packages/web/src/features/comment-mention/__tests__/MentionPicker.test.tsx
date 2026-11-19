// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommentMention } from '@breatic/shared';
import { MentionPicker } from '@web/features/comment-mention/MentionPicker';
import { useCurrentUserStore } from '@web/stores/current-user';

const roster = vi.hoisted(() => ({
  value: {
    members: [] as Array<{ userId: string; name: string }>,
    isLoading: false,
    isError: false,
    retry: vi.fn(),
  },
}));

vi.mock('@web/data/use-project-members', () => ({
  useProjectMembers: () => roster.value,
}));

/**
 * A box with the picker, as a comment box wires it.
 * @param props - Test props.
 * @param props.onPick - Spy for what the picker hands back.
 * @param props.onKeyDown - Spy for the box's own keys.
 * @returns The harness.
 */
function Harness({
  onPick,
  onKeyDown,
}: {
  onPick: (text: string, m: CommentMention) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}): React.JSX.Element {
  const [text, setText] = React.useState('');
  const ref = React.useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <textarea
        ref={ref}
        data-testid='box'
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <MentionPicker
        projectId='p1'
        boxRef={ref}
        text={text}
        onPick={(next, m) => {
          setText(next);
          onPick(next, m);
        }}
      />
    </>
  );
}

/**
 * Type into the box with the caret at the end.
 * @param value - The words.
 */
function type(value: string): void {
  const box = screen.getByTestId('box') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value } });
  box.setSelectionRange(value.length, value.length);
  fireEvent.keyUp(box);
}

describe('MentionPicker', () => {
  beforeEach(() => {
    roster.value = {
      members: [
        { userId: 'me', name: 'Me' },
        { userId: 'u1', name: 'Alice' },
        { userId: 'u2', name: 'Bob' },
      ],
      isLoading: false,
      isError: false,
      retry: vi.fn(),
    };
    useCurrentUserStore.setState({ user: { id: 'me' } as never });
  });

  it('lists the other members matching what follows the @', () => {
    render(<Harness onPick={vi.fn()} />);
    type('hi @');
    expect(screen.getByTestId('mention-picker-member-u2')).toBeInTheDocument();
    expect(screen.queryByTestId('mention-picker-member-me')).toBeNull();
    type('hi @a');
    expect(screen.getByTestId('mention-picker-member-u1')).toBeInTheDocument();
    expect(screen.queryByTestId('mention-picker-member-u2')).toBeNull();
  });

  it('stays closed until an @ is typed', () => {
    render(<Harness onPick={vi.fn()} />);
    type('hi a');
    expect(screen.queryByTestId('mention-picker')).toBeNull();
  });

  it('writes the name in place of the query and records the member', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    type('hi @Al');
    fireEvent.click(screen.getByTestId('mention-picker-member-u1'));
    expect(onPick).toHaveBeenCalledWith(
      'hi @Alice ',
      expect.objectContaining({ userId: 'u1', projectId: 'p1', label: '@Alice' }),
    );
    expect(screen.getByTestId('box')).toHaveValue('hi @Alice ');
  });

  it('keeps the caret in the box when a member is pressed', () => {
    render(<Harness onPick={vi.fn()} />);
    type('@');
    const pressed = fireEvent.mouseDown(screen.getByTestId('mention-picker-member-u1'));
    expect(pressed).toBe(false);
  });

  it('shows placeholders while the roster loads', () => {
    roster.value = { ...roster.value, members: [], isLoading: true };
    render(<Harness onPick={vi.fn()} />);
    type('@');
    expect(screen.getByTestId('mention-picker-loading')).toBeInTheDocument();
  });

  it('offers a retry when the roster fails', () => {
    const retry = vi.fn();
    roster.value = { ...roster.value, members: [], isError: true, retry };
    render(<Harness onPick={vi.fn()} />);
    type('@');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('says so when nobody matches', () => {
    render(<Harness onPick={vi.fn()} />);
    type('@zz');
    expect(screen.getByText('No matching members')).toBeInTheDocument();
  });

  it('closes on Escape without the box seeing the key', () => {
    const onKeyDown = vi.fn();
    render(<Harness onPick={vi.fn()} onKeyDown={onKeyDown} />);
    type('@');
    fireEvent.keyDown(screen.getByTestId('box'), { key: 'Escape' });
    expect(screen.queryByTestId('mention-picker')).toBeNull();
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
