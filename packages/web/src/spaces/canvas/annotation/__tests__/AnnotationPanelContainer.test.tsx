// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { AnnotationNamesContext } from '@web/spaces/canvas/annotation/names';
import { AnnotationPanelContainer } from '@web/spaces/canvas/annotation/AnnotationPanelContainer';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { useCanvasStore } from '@web/stores/canvas';
import { useUIStore } from '@web/stores/ui';

vi.mock('@web/data/yjs/canvas-space', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  addReply: () => true,
  editAnnotationBody: () => true,
  editReply: () => true,
  removeReply: () => true,
}));

const warn = vi.fn();
vi.mock('@web/lib/toast', () => ({ toast: { warning: (m: string) => warn(m) } }));

const NAMES = new Map([['u-me', { id: 'u-me', name: 'Mika', email: '' }]]);

const NODES: readonly CanvasNodeView[] = [
  {
    id: 'n1',
    type: 'annotation',
    position: { x: 0, y: 0 },
    data: {
      kind: 'annotation',
      content: 'a cooler shot here',
      createdBy: 'u-me',
      createdAt: 1_757_000_000_000,
      replies: [],
    },
  } as unknown as CanvasNodeView,
];

/**
 * Mount the panel with one note open in the exclusive slot.
 * @param nodes - The board's nodes.
 * @returns The render result.
 */
function mount(nodes: readonly CanvasNodeView[] = NODES): ReturnType<
  typeof render
> {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ReactFlowProvider>
        <CanvasContext.Provider
          value={{
            projectId: 'p1',
            spaceId: 's1',
            readOnly: false,
            myRole: 'editor',
            caretProvider: null,
          }}
        >
          <CanvasActionsContext.Provider
            value={{
              renameNode: () => undefined,
              deleteEdge: () => undefined,
              deleteNode: () => undefined,
              activateNodeUpload: () => undefined,
              commitGroupResize: () => undefined,
              reportGroupResize: () => undefined,
              beginGroupResize: () => undefined,
            }}
          >
            <AnnotationNamesContext.Provider value={NAMES}>
              <AnnotationPanelContainer nodes={nodes} />
            </AnnotationNamesContext.Provider>
          </CanvasActionsContext.Provider>
        </CanvasContext.Provider>
      </ReactFlowProvider>
    </QueryClientProvider>,
  );
}

/**
 * Whether a note is still expanded in the exclusive slot.
 * @returns True while the slot holds this note.
 */
const stillOpen = (): boolean =>
  useCanvasStore.getState().panelKind === 'annotation';

beforeEach(() => {
  warn.mockClear();
  useCanvasStore.getState().reset();
  useUIStore.setState({ activeRegion: 'space' });
  useCanvasStore.getState().openAnnotationPanel('n1');
});

describe('a note deleted while somebody is writing on it', () => {
  it('says so, because the sticky that would have said it is gone too', () => {
    // §6.2's "deleted in Yjs" row and §8.4 both ask for a word. The drop
    // notice that carries one lives inside the sticky (it reads "This reply
    // was deleted"), and the sticky unmounts with its host — so the one case
    // where the whole note goes had no surface at all: the words vanished
    // mid-keystroke with nothing said.
    useCanvasStore.getState().setAnnotationDraft('n1', {
      draft: {
        mode: 'typing',
        use: 'reply',
        text: 'half an answer',
        opened: '',
      },
      target: null,
    });
    const view = mount();
    view.rerender(<div />);
    view.unmount();

    const gone = mount([]);
    expect(warn).toHaveBeenCalledTimes(1);
    gone.unmount();
  });

  it('stays quiet when nothing was being written', () => {
    // A pin disappearing IS the news, and §8.7.3 asks for no second line.
    const gone = mount([]);
    expect(warn).not.toHaveBeenCalled();
    gone.unmount();
  });
});

describe('Escape, as the sticky answers it', () => {
  it('collapses the note when the press is the canvas own', () => {
    mount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(stillOpen()).toBe(false);
  });

  it('leaves it open when something else already took the press', () => {
    // Radix dismisses a menu or a popover by calling `preventDefault` on the
    // press (`react-dismissable-layer`), which is how Escape peels one layer
    // at a time. Measured before this: the ⋯ menu closed AND the sticky
    // collapsed on the same key.
    mount();
    const press = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    press.preventDefault();
    document.body.dispatchEvent(press);
    expect(stillOpen()).toBe(true);
  });

  it('leaves it open while an IME is composing', () => {
    // The press is dismissing a candidate window. Measured before this: the
    // sticky collapsed under the reader mid-word.
    mount();
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    expect(stillOpen()).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 229 });
    expect(stillOpen()).toBe(true);
  });

  it('leaves it open when the agent column owns the keyboard', () => {
    // Two regions share this window, and a press belongs to the one the
    // reader is working in. Measured before this: Escape in the chat composer
    // collapsed a note on the canvas behind it.
    mount();
    useUIStore.setState({ activeRegion: 'agent' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(stillOpen()).toBe(true);
  });

  it('leaves it open on an auto-repeated press', () => {
    mount();
    fireEvent.keyDown(document.body, { key: 'Escape', repeat: true });
    expect(stillOpen()).toBe(true);
  });
});
