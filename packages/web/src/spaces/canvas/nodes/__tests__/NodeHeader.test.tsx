// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { NodeHeader } from '@web/spaces/canvas/nodes/_shared/NodeHeader';

describe('NodeHeader', () => {
  it('shows the name', () => {
    render(<NodeHeader modality='image' name='Hero shot' onRename={() => {}} />);
    expect(screen.getByTestId('node-header')).toHaveTextContent('Hero shot');
  });

  it('falls back to the modality label when the name is blank', () => {
    render(<NodeHeader modality='audio' name='' onRename={() => {}} />);
    expect(screen.getByTestId('node-header')).toHaveTextContent('Audio');
  });

  it('double-click enters edit and Enter commits the new name', () => {
    const onRename = vi.fn();
    render(<NodeHeader modality='image' name='Old' onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('New name');
  });

  it('Escape cancels without committing', () => {
    const onRename = vi.fn();
    render(<NodeHeader modality='image' name='Old' onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('Escape marks the event consumed so window-level Esc handlers yield (round-12)', () => {
    render(<NodeHeader modality='image' name='Old' onRename={vi.fn()} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    // A window-level Esc consumer (the focus-session exit, the crop overlay
    // staging) keys its yield on `defaultPrevented` — canceling a rename
    // must never ALSO tear down a focus session (round-12).
    const seen: boolean[] = [];
    const onWindowKeyDown = (e: KeyboardEvent): void => {
      seen.push(e.defaultPrevented);
    };
    window.addEventListener('keydown', onWindowKeyDown);
    try {
      const evt = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      // A raw dispatch (not fireEvent) so the NATIVE event's
      // defaultPrevented is observable at the window — wrapped in act()
      // to flush the cancel's state update.
      act(() => {
        input.dispatchEvent(evt);
      });
      expect(evt.defaultPrevented).toBe(true);
      expect(seen).toEqual([true]);
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }
    // The cancel itself still ran — the editor closed.
    expect(screen.queryByTestId('node-header-input')).toBeNull();
  });

  it('does not commit a blank rename', () => {
    const onRename = vi.fn();
    render(<NodeHeader modality='image' name='Old' onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('read-only: double-click does not enter edit', () => {
    render(<NodeHeader modality='image' name='Old' readOnly onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    expect(screen.queryByTestId('node-header-input')).toBeNull();
  });

  // The rename matches the project-title editor (TitleEditable): no input
  // chrome box — a borderless subtle-fill field, not a bordered input.
  it('rename input is borderless like the project title', () => {
    render(<NodeHeader modality='image' name='Old' onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    expect(input.className).toContain('border-0');
    expect(input.className).not.toContain('border-border');
    expect(input.className).not.toContain('focus-visible:border-active-border');
    expect(input.className).toContain('bg-muted');
  });

  // Entering edit must NOT shift the name sideways (the reported bug). The
  // input keeps `px-1` for the fill's breathing room but adds `-ml-1` to cancel
  // that left padding's horizontal offset, so the text stays at the same x as
  // the static span — matching the project-title editor's no-shift behaviour.
  it('rename input compensates its left padding so the name does not shift', () => {
    render(<NodeHeader modality='image' name='Old' onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    expect(input.className).toContain('px-1');
    expect(input.className).toContain('-ml-1');
  });

  // #1314: the rename input uses the new 2px radius tier (rounded-content-xs),
  // tighter than the 6px chrome radius the rest of chrome uses.
  it('rename input uses the 2px radius (rounded-content-xs)', () => {
    render(<NodeHeader modality='image' name='Old' onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    expect(input.className).toContain('rounded-content-xs');
    expect(input.className).not.toContain('rounded-chrome');
  });

  // ReactFlow drags a node when a pointer press starts inside it; the rename
  // input must carry `nodrag` so dragging to select text edits the name
  // instead of moving the whole node.
  it('rename input carries nodrag so selecting text does not move the node', () => {
    render(<NodeHeader modality='image' name='Old' onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    expect(screen.getByTestId('node-header-input').className).toContain('nodrag');
  });

  // Double-click selects the whole name (like the project title) so the user
  // can type to replace it immediately.
  it('double-click selects the whole name', () => {
    render(<NodeHeader modality='image' name='Hero shot' onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId<HTMLInputElement>('node-header-input');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  // The input width follows the content length (field-sizing) so it doesn't
  // sit at a fixed full-width box while editing a short name.
  it('rename input grows with its content', () => {
    render(<NodeHeader modality='image' name='Old' onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    expect(screen.getByTestId('node-header-input').className).toContain(
      '[field-sizing:content]',
    );
  });

  it('caps the node name at 30 characters', () => {
    const onRename = vi.fn();
    render(<NodeHeader modality='image' name='Old' onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    expect(input).toHaveAttribute('maxlength', '30');
    // Defense in depth: even if a 40-char value slips past maxLength (paste),
    // commit slices it to 30 before firing the rename.
    fireEvent.change(input, { target: { value: 'x'.repeat(40) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('x'.repeat(30));
  });

  // #2: the header sits tight above the card — no bottom padding adding to the
  // gap (the constant gap is owned by the frame's absolute header anchor).
  it('header carries no bottom padding', () => {
    render(<NodeHeader modality='image' name='Old' onRename={() => {}} />);
    expect(screen.getByTestId('node-header').className).not.toContain('pb-1');
  });

  // #1449: the name (and the icon, via currentColor) deepens/brightens with
  // selection so the active node reads at a glance even when the zoom-thinned
  // selection border is faint. Selected → text-foreground (deep in light,
  // bright in dark); unselected → text-muted-foreground (mid grey).
  it('selected: the name uses the strong foreground colour', () => {
    render(
      <NodeHeader modality='image' name='Old' selected onRename={() => {}} />,
    );
    const header = screen.getByTestId('node-header');
    expect(header).toHaveClass('text-foreground');
    expect(header).not.toHaveClass('text-muted-foreground');
  });

  it('unselected: the name dims to the muted foreground colour', () => {
    render(<NodeHeader modality='image' name='Old' onRename={() => {}} />);
    const header = screen.getByTestId('node-header');
    expect(header).toHaveClass('text-muted-foreground');
    expect(header).not.toHaveClass('text-foreground');
  });
});
