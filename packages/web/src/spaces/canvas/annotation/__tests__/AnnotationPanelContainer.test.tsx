// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
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
 * The panel, around whatever board is passed in.
 * @param nodes - The board's nodes.
 * @param wroteLocally - What the document says about who wrote the last change.
 * @returns The element tree.
 */
const tree = (
  nodes: readonly CanvasNodeView[],
  wroteLocally = false,
): React.JSX.Element => (
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
            <AnnotationPanelContainer
              nodes={nodes}
              getLastWriteWasLocal={() => wroteLocally}
            />
          </AnnotationNamesContext.Provider>
        </CanvasActionsContext.Provider>
      </CanvasContext.Provider>
    </ReactFlowProvider>
  </QueryClientProvider>
);

/**
 * Mount the panel with one note open in the exclusive slot.
 * @param nodes - The board's nodes.
 * @param wroteLocally - What the document says about who wrote the last change.
 * @returns The render result.
 */
function mount(
  nodes: readonly CanvasNodeView[] = NODES,
  wroteLocally = false,
): ReturnType<typeof render> {
  return render(tree(nodes, wroteLocally));
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

/**
 * Hold a draft for the note, the way typing in the sticky does.
 * @param mode - Whether somebody is mid-keystroke or the box is shut.
 */
function holdADraft(mode: 'typing' | 'closed'): void {
  useCanvasStore.getState().setAnnotationDraft('n1', {
    draft: { mode, use: 'reply', text: 'half an answer', opened: '' },
    target: null,
  });
}

describe('a note that goes missing under an open sticky', () => {
  it('says so when a collaborator deleted it while somebody was writing', () => {
    // §6.2's "deleted in Yjs" row and §8.4 both ask for a word. The drop
    // notice that carries one lives inside the sticky (it reads "This reply
    // was deleted"), and the sticky unmounts with its host — so the one case
    // where the whole note goes had no surface at all.
    //
    // A deletion is the board LOSING a note it was showing, which is why this
    // draws it first and takes it away second. The text is asserted, not just
    // the count: the reply's "this reply was deleted" sits one identifier away
    // in the same namespace, and telling a reader whose whole note went that a
    // reply went points at something that did not happen.
    holdADraft('typing');
    const view = mount();
    view.rerender(tree([]));
    expect(warn).toHaveBeenCalledWith('This note was deleted.');
    expect(stillOpen()).toBe(false);
    view.unmount();
  });

  it('stays quiet when this end is the one that deleted it', () => {
    // Deleting your own note is not news about your note. Who wrote the change
    // is what the document knows and what the three sibling panels already ask
    // (`CanvasSpace.tsx:894` draws the same distinction for the focus session)
    // — asked as "which entry point ran" instead, the answer is a list of
    // today's callers, and the keyboard Delete was not on it.
    holdADraft('typing');
    const view = mount(NODES, true);
    view.rerender(tree([], true));
    expect(warn).not.toHaveBeenCalled();
    expect(stillOpen()).toBe(false);
    view.unmount();
  });

  it('stays quiet when this board never had the note at all', () => {
    // Switching Space remounts the canvas with another board's nodes while
    // the panel slot and the drafts carry over (they are cleared per PROJECT,
    // `ProjectPage.tsx:201`). Measured on a board before this: a half-typed
    // reply plus a click on another Space tab read "This note was deleted."
    holdADraft('typing');
    const other = mount([]);
    expect(warn).not.toHaveBeenCalled();
    other.unmount();
  });

  it('stays quiet when the held draft is only a notice nobody dismissed', () => {
    // A dropped reply leaves a closed draft behind so the sticky can say what
    // happened until the reader waves it away. Nobody is writing in it.
    holdADraft('closed');
    const view = mount();
    view.rerender(tree([]));
    expect(warn).not.toHaveBeenCalled();
    view.unmount();
  });

  it('stays quiet when nothing was being written', () => {
    // A pin disappearing IS the news, and §8.7.3 asks for no second line.
    const view = mount();
    view.rerender(tree([]));
    expect(warn).not.toHaveBeenCalled();
    expect(stillOpen()).toBe(false);
    view.unmount();
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

  it('ends what was being written when it collapses the note', () => {
    // The press collapses the sticky, and a collapsed sticky is a closed one.
    holdADraft('typing');
    mount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useCanvasStore.getState().annotationDrafts['n1']).toBeUndefined();
  });

  it('leaves it open while the note tool is armed, which the press is for', () => {
    // Two modes on this canvas take Escape and they are stacked: the tool the
    // reader just picked up sits over the note they opened earlier, so the
    // press puts the tool down and the next one collapses the note. Measured
    // before this, with both listening: one press did both.
    useCanvasStore.getState().startAnnotationPlacement();
    mount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(stillOpen()).toBe(true);
  });
});

describe('a draft lives from the sticky opening to the sticky closing', () => {
  it('drops what was being written when the sticky closes', () => {
    // User 2026-09-15: as long as the reply panel is open what was typed must
    // not be lost, and coming back to it continues where the writer left off —
    // it is closing the whole panel that ends it. The other half of that rule
    // (a blur keeps a reply and a rewrite) lives in the reducer; this is the
    // half that ends them, and without it a rewrite outlived the close: the
    // note reopened showing the writer's own stale text, a collaborator's
    // newer body nowhere on screen, and Save wrote over it.
    holdADraft('typing');
    const view = mount();
    act(() => useCanvasStore.getState().closeActivePanel());
    expect(useCanvasStore.getState().annotationDrafts['n1']).toBeUndefined();
    view.unmount();
  });

  it('drops it when another note takes the slot', () => {
    // One slot, so opening another note closes this one. Same close, same end.
    holdADraft('typing');
    const view = mount();
    act(() => useCanvasStore.getState().openAnnotationPanel('n2'));
    expect(useCanvasStore.getState().annotationDrafts['n1']).toBeUndefined();
    view.unmount();
  });

  it('keeps it while the sticky stays open', () => {
    // The blur rule rests on this: a caret leaving the box is not a close, so
    // a reply half typed is still there when the reader clicks back into it.
    holdADraft('typing');
    const view = mount();
    view.rerender(tree(NODES));
    expect(useCanvasStore.getState().annotationDrafts['n1']).toBeDefined();
    view.unmount();
  });
});
