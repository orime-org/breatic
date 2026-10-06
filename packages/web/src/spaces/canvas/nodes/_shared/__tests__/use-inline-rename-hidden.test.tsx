// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import * as React from 'react';

import { useInlineRename } from '@web/spaces/canvas/nodes/_shared/use-inline-rename';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';

/** A canvas on Space `s1`, the outlet these cases put on the page. */
const CANVAS: CanvasContextValue = {
  projectId: 'p',
  spaceId: 's1',
  readOnly: false,
  myRole: 'owner',
  caretProvider: null,
};


/**
 * A name editor wired the way the node header wires it.
 * @param root0 - Props.
 * @param root0.onRename - Called with a committed name.
 * @returns The editor.
 */
function Editor({ onRename }: { onRename: (name: string) => void }): React.JSX.Element {
  const rename = useInlineRename({ current: 'Hero', maxLength: 40, onRename });
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    rename.startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return rename.editing ? (
    <input
      ref={rename.inputRef}
      data-testid='name'
      value={rename.draft}
      onChange={(e) => rename.setDraft(e.target.value)}
      onBlur={rename.blur}
    />
  ) : (
    <span>{rename.displayName}</span>
  );
}

/**
 * The editor inside a Space that can be hidden.
 * @param root0 - Props.
 * @param root0.hidden - Whether the Space is switched away from.
 * @param root0.onRename - Called with a committed name.
 * @returns The Space.
 */
function Space({
  hidden,
  onRename,
}: {
  hidden: boolean;
  onRename: (name: string) => void;
}): React.JSX.Element {
  return (
    <div data-space-outlet='s1' style={hidden ? { display: 'none' } : undefined}>
      <CanvasContext.Provider value={CANVAS}>
        <React.Activity mode={hidden ? 'hidden' : 'visible'}>
          <Editor onRename={onRename} />
        </React.Activity>
      </CanvasContext.Provider>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a name being edited in a Space that is hidden', () => {
  it('stays open with the words typed so far', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onRename = vi.fn();
    const view = render(<Space hidden={false} onRename={onRename} />);
    const input = view.getByTestId('name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hero sh' } });

    view.rerender(<Space hidden onRename={onRename} />);
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(<Space hidden={false} onRename={onRename} />);

    expect(onRename).not.toHaveBeenCalled();
    expect((view.getByTestId('name') as HTMLInputElement).value).toBe('Hero sh');
  });

  it('commits when focus leaves it while the Space is on screen', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onRename = vi.fn();
    const view = render(<Space hidden={false} onRename={onRename} />);
    const input = view.getByTestId('name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hero shot' } });

    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('Hero shot');
  });

  it('comes back with the name as it was, not the whole of it selected', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const view = render(<Space hidden={false} onRename={vi.fn()} />);
    const input = view.getByTestId('name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hero sh' } });
    input.setSelectionRange(7, 7);

    view.rerender(<Space hidden onRename={vi.fn()} />);
    view.rerender(<Space hidden={false} onRename={vi.fn()} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect([input.selectionStart, input.selectionEnd]).toEqual([7, 7]);
  });
});
