// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { EmptyImagePanel } from '@web/spaces/canvas/empty-image/EmptyImagePanel';

describe('EmptyImagePanel', () => {
  it('executes with the default 1024² white spec', () => {
    const onExecute = vi.fn();
    render(<EmptyImagePanel onExecute={onExecute} onExit={() => {}} />);
    fireEvent.click(screen.getByTestId('empty-image-execute'));
    expect(onExecute).toHaveBeenCalledWith({
      width: 1024,
      height: 1024,
      color: '#ffffff',
    });
  });

  it('a ratio preset derives the W/H the execute emits', () => {
    const onExecute = vi.fn();
    render(<EmptyImagePanel onExecute={onExecute} onExit={() => {}} />);
    fireEvent.click(screen.getByTestId('empty-image-ratio-16:9'));
    fireEvent.click(screen.getByTestId('empty-image-execute'));
    expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1024, height: 576 }),
    );
  });

  it('clamps a hand-typed out-of-range dimension on execute', () => {
    const onExecute = vi.fn();
    render(<EmptyImagePanel onExecute={onExecute} onExit={() => {}} />);
    fireEvent.change(screen.getByTestId('empty-image-width'), {
      target: { value: '99999' },
    });
    fireEvent.change(screen.getByTestId('empty-image-height'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByTestId('empty-image-execute'));
    expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ width: 4096, height: 16 }),
    );
  });

  it('an empty field on execute falls back to the default (blur-independent)', () => {
    const onExecute = vi.fn();
    render(<EmptyImagePanel onExecute={onExecute} onExit={() => {}} />);
    // Clear width WITHOUT blurring, then execute — the execute path normalises
    // the same as blur, so empty → default (not 0 → min).
    fireEvent.change(screen.getByTestId('empty-image-width'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('empty-image-execute'));
    expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1024 }),
    );
  });

  it('a swatch sets the fill colour the execute emits', () => {
    const onExecute = vi.fn();
    render(<EmptyImagePanel onExecute={onExecute} onExit={() => {}} />);
    fireEvent.click(screen.getByTestId('empty-image-color-black'));
    fireEvent.click(screen.getByTestId('empty-image-execute'));
    expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ color: '#000000' }),
    );
  });

  it('Exit closes without executing', () => {
    const onExecute = vi.fn();
    const onExit = vi.fn();
    render(<EmptyImagePanel onExecute={onExecute} onExit={onExit} />);
    fireEvent.click(screen.getByTestId('empty-image-exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();
  });
});
