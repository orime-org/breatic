// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TitleEditable } from '@web/pages/project/chrome/top-bar/TitleEditable';

describe('TitleEditable', () => {
  it('renders the title in static mode by default', () => {
    render(<TitleEditable value='My project' onChange={vi.fn()} />);
    expect(screen.getByTestId('title-display')).toHaveTextContent('My project');
  });

  it('double-click enters edit mode when editable (default)', async () => {
    const user = userEvent.setup();
    render(<TitleEditable value='My project' onChange={vi.fn()} />);
    await user.dblClick(screen.getByTestId('title-display'));
    expect(await screen.findByTestId('title-input')).toBeInTheDocument();
  });

  describe('editable=false (read-only viewer title)', () => {
    it('double-click does NOT enter edit mode', async () => {
      const user = userEvent.setup();
      render(
        <TitleEditable value='My project' onChange={vi.fn()} editable={false} />,
      );
      await user.dblClick(screen.getByTestId('title-display'));
      expect(screen.queryByTestId('title-input')).toBeNull();
    });

    it('Enter / Space on the title does NOT enter edit mode', async () => {
      const user = userEvent.setup();
      render(
        <TitleEditable value='My project' onChange={vi.fn()} editable={false} />,
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
        <TitleEditable value='My project' onChange={vi.fn()} editable={false} />,
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
    render(<TitleEditable value='' placeholder='Untitled' onChange={vi.fn()} />);

    expect(screen.getByTestId('title-display')).toHaveTextContent('Untitled');
    await user.dblClick(screen.getByTestId('title-display'));

    expect(await screen.findByTestId('title-input')).toHaveValue('');
  });

});
