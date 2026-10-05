// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { EmptyImagePanel } from '@web/spaces/canvas/empty-image/EmptyImagePanel';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';

import {
  expectChosenFill,
  expectHoverableSiblingFill,
} from '@web/test-utils/selection-fill';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A canvas on Space `s1`, the outlet these cases put on the page. */
const CANVAS: CanvasContextValue = {
  projectId: 'p',
  spaceId: 's1',
  readOnly: false,
  myRole: 'owner',
  caretProvider: null,
};

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

  it('fills the picked ratio past the fill the others take under the pointer', () => {
    render(<EmptyImagePanel onExecute={vi.fn()} onExit={() => {}} />);
    // The panel opens on 1:1, which is what the default 1024² spec is.
    expectChosenFill(screen.getByTestId('empty-image-ratio-1:1'));
    expectHoverableSiblingFill(screen.getByTestId('empty-image-ratio-16:9'));
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

/**
 * The panel inside a Space that can be hidden.
 * @param root0 - Props.
 * @param root0.hidden - Whether the Space is switched away from.
 * @returns The Space.
 */
function Space({ hidden }: { hidden: boolean }): React.JSX.Element {
  return (
    <div data-space-outlet='s1' style={hidden ? { display: 'none' } : undefined}>
      <CanvasContext.Provider value={CANVAS}>
        <React.Activity mode={hidden ? 'hidden' : 'visible'}>
          <EmptyImagePanel onExecute={vi.fn()} onExit={() => {}} />
        </React.Activity>
      </CanvasContext.Provider>
    </div>
  );
}

describe('EmptyImagePanel in a Space switched away from', () => {
  it('keeps a size being typed', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const view = render(<Space hidden={false} />);
    const width = screen.getByTestId('empty-image-width') as HTMLInputElement;
    width.focus();
    fireEvent.change(width, { target: { value: '10' } });

    view.rerender(<Space hidden />);
    fireEvent.blur(width);
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(<Space hidden={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(width.value).toBe('10');
  });
});
