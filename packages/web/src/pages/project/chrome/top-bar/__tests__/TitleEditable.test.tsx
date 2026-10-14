// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TitleEditable } from '@web/pages/project/chrome/top-bar/TitleEditable';

describe('TitleEditable', () => {
  it('renders the title in static mode by default', () => {
    render(<TitleEditable maxLength={255} value='My project' onChange={vi.fn()} />);
    expect(screen.getByTestId('title-display')).toHaveTextContent('My project');
  });

  it('double-click enters edit mode when editable (default)', async () => {
    const user = userEvent.setup();
    render(<TitleEditable maxLength={255} value='My project' onChange={vi.fn()} />);
    await user.dblClick(screen.getByTestId('title-display'));
    expect(await screen.findByTestId('title-input')).toBeInTheDocument();
  });

  describe('editable=false (read-only viewer title)', () => {
    it('double-click does NOT enter edit mode', async () => {
      const user = userEvent.setup();
      render(
        <TitleEditable maxLength={255} value='My project' onChange={vi.fn()} editable={false} />,
      );
      await user.dblClick(screen.getByTestId('title-display'));
      expect(screen.queryByTestId('title-input')).toBeNull();
    });

    it('Enter / Space on the title does NOT enter edit mode', async () => {
      const user = userEvent.setup();
      render(
        <TitleEditable maxLength={255} value='My project' onChange={vi.fn()} editable={false} />,
      );
      const display = screen.getByTestId('title-display');
      display.focus();
      await user.keyboard('{Enter}');
      expect(screen.queryByTestId('title-input')).toBeNull();
      await user.keyboard(' ');
      expect(screen.queryByTestId('title-input')).toBeNull();
    });

    it('exposes no editing affordance (not a focusable textbox)', () => {
      render(
        <TitleEditable maxLength={255} value='My project' onChange={vi.fn()} editable={false} />,
      );
      const display = screen.getByTestId('title-display');
      expect(display).not.toHaveAttribute('role', 'textbox');
      expect(display).not.toHaveAttribute('tabindex', '0');
    });
  });
});

describe('a thing that has no name yet', () => {
  it('shows the stand-in without treating it as the name', async () => {
    // 没名字的会话在顶栏显示一句「新对话」,那是个替身、不是它的名字。
    // 双击进去时框里该是空的 —— 预填替身就等于替它取了个名。
    const user = userEvent.setup();
    render(<TitleEditable maxLength={255} value='' placeholder='Untitled' onChange={vi.fn()} />);

    expect(screen.getByTestId('title-display')).toHaveTextContent('Untitled');
    await user.dblClick(screen.getByTestId('title-display'));

    expect(await screen.findByTestId('title-input')).toHaveValue('');
  });

});

// The project title and the Agent column conversation title are both this
// box (inner#956): ending the edit from the keyboard gives the keyboard back
// to the title, without opening the box again.
describe('ending an edit from the keyboard', () => {
  it.each(['Enter', 'Escape'])('gives the title the keyboard on %s', async (key) => {
    const user = userEvent.setup();
    render(<TitleEditable maxLength={255} value='My project' onChange={vi.fn()} />);
    screen.getByTestId('title-display').focus();
    await user.keyboard('{Enter}');
    await user.type(screen.getByTestId('title-input'), `x{${key}}`);
    expect(screen.queryByTestId('title-input')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('title-display'));
  });

  it('does not reopen the box while the Enter that closed it is held', async () => {
    const user = userEvent.setup();
    render(<TitleEditable maxLength={255} value='My project' onChange={vi.fn()} />);
    await user.dblClick(screen.getByTestId('title-display'));
    fireEvent.keyDown(screen.getByTestId('title-input'), { key: 'Enter', keyCode: 13 });
    const title = screen.getByTestId('title-display');
    expect(document.activeElement).toBe(title);
    fireEvent.keyDown(title, { key: 'Enter', keyCode: 13, repeat: true });
    expect(screen.queryByTestId('title-input')).toBeNull();
  });

  it.each([
    ['Enter', { key: 'Enter', keyCode: 13 }],
    ['Escape', { key: 'Escape', keyCode: 27 }],
  ])('keeps the box open on the %s that ends an input method composition', async (_, init) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TitleEditable maxLength={255} value='My project' onChange={onChange} />);
    await user.dblClick(screen.getByTestId('title-display'));
    const input = screen.getByTestId('title-input');
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, init);
    expect(screen.getByTestId('title-input')).toBe(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the name shown after a rename is committed (inner#1440)', () => {
  /**
   * Opens the box, replaces the name and presses Enter.
   * @param user - The user-event instance.
   * @param name - What to type.
   */
  async function renameTo(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
    await user.dblClick(screen.getByTestId('title-display'));
    const box = await screen.findByTestId('title-input');
    await user.clear(box);
    await user.type(box, `${name}{Enter}`);
  }

  it('shows the new name while the value has not caught up', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TitleEditable maxLength={255} value='A' onChange={vi.fn()} />);
    await renameTo(user, 'B');
    expect(screen.getByTestId('title-display')).toHaveTextContent('B');
    rerender(<TitleEditable maxLength={255} value='B' onChange={vi.fn()} />);
    expect(screen.getByTestId('title-display')).toHaveTextContent('B');
  });

  it('follows the value once it changes after the rename', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TitleEditable maxLength={255} value='A' onChange={vi.fn()} />);
    await renameTo(user, 'B');
    rerender(<TitleEditable maxLength={255} value='X' onChange={vi.fn()} />);
    expect(screen.getByTestId('title-display')).toHaveTextContent('X');
  });

  it('goes back to the value when the rename is refused', async () => {
    const user = userEvent.setup();
    let refuse: (reason: Error) => void = () => undefined;
    const onChange = vi.fn(() => new Promise<void>((_, reject) => { refuse = reject; }));
    render(<TitleEditable maxLength={255} value='A' onChange={onChange} />);
    await renameTo(user, 'B');
    expect(screen.getByTestId('title-display')).toHaveTextContent('B');
    refuse(new Error('refused'));
    await vi.waitFor(() => expect(screen.getByTestId('title-display')).toHaveTextContent('A'));
  });

  it('keeps a newer name when an older rename is refused late', async () => {
    const user = userEvent.setup();
    const refusals: Array<(reason: Error) => void> = [];
    const onChange = vi.fn(() => new Promise<void>((_, reject) => { refusals.push(reject); }));
    render(<TitleEditable maxLength={255} value='A' onChange={onChange} />);
    await renameTo(user, 'B');
    await renameTo(user, 'C');
    refusals[0]?.(new Error('refused'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('title-display')).toHaveTextContent('C');
  });
});
