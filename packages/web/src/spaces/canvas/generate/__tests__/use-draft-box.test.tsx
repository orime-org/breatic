// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import * as React from 'react';

import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { useDraftBox } from '@web/spaces/canvas/generate/use-draft-box';

/** A canvas on Space `s1`, the outlet these cases put on the page. */
const CANVAS: CanvasContextValue = {
  projectId: 'p',
  spaceId: 's1',
  readOnly: false,
  myRole: 'owner',
  caretProvider: null,
};

/**
 * A box committing what is typed into it.
 * @param root0 - Props.
 * @param root0.onCommit - Called with a changed value.
 * @returns The box.
 */
function Box({ onCommit }: { onCommit: (next: string) => void }): React.JSX.Element {
  const box = useDraftBox('Alice', onCommit);
  return <input data-testid='box' {...box} />;
}

/**
 * The box inside a Space that can be hidden.
 * @param root0 - Props.
 * @param root0.hidden - Whether the Space is switched away from.
 * @param root0.onCommit - Called with a changed value.
 * @returns The Space.
 */
function Space({
  hidden,
  onCommit,
}: {
  hidden: boolean;
  onCommit: (next: string) => void;
}): React.JSX.Element {
  return (
    <div data-space-outlet='s1' style={hidden ? { display: 'none' } : undefined}>
      <CanvasContext.Provider value={CANVAS}>
        <React.Activity mode={hidden ? 'hidden' : 'visible'}>
          <Box onCommit={onCommit} />
        </React.Activity>
      </CanvasContext.Provider>
    </div>
  );
}

/**
 * Settles the microtask the blur decision waits for and the task the caret
 * returns in.
 * @returns Nothing.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDraftBox', () => {
  it('commits when focus leaves it while the Space is on screen', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onCommit = vi.fn();
    const view = render(<Space hidden={false} onCommit={onCommit} />);
    const box = view.getByTestId('box') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'Alicia' } });
    fireEvent.blur(box);
    await settle();
    expect(onCommit).toHaveBeenCalledWith('Alicia');
    expect(box.value).toBe('Alice');
  });

  it('commits on Enter', () => {
    const onCommit = vi.fn();
    const view = render(<Space hidden={false} onCommit={onCommit} />);
    const box = view.getByTestId('box') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'Alicia' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Alicia');
  });

  it('keeps the words when its Space is hidden and shown', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onCommit = vi.fn();
    const view = render(<Space hidden={false} onCommit={onCommit} />);
    const box = view.getByTestId('box') as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'Alic' } });

    view.rerender(<Space hidden onCommit={onCommit} />);
    fireEvent.blur(box);
    await settle();
    view.rerender(<Space hidden={false} onCommit={onCommit} />);
    await settle();

    expect(onCommit).not.toHaveBeenCalled();
    expect(box.value).toBe('Alic');
  });
});
