// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mentioning a member in a canvas note (#1488 §11.6): the `@` list in each
 * box, and the mentions written beside the words.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import userEvent from '@testing-library/user-event';

import type { AnnotationNodeView } from '@breatic/shared/canvas-model';
import { AnnotationComposer } from '@web/spaces/canvas/annotation/AnnotationComposer';
import { AnnotationSticky } from '@web/spaces/canvas/annotation/AnnotationSticky';
import { AnnotationNamesContext } from '@web/spaces/canvas/annotation/names';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { useCanvasStore } from '@web/stores/canvas';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCurrentUserStore } from '@web/stores/current-user';

const addReply = vi.fn();
const editAnnotationBody = vi.fn();
const editReply = vi.fn();

vi.mock('@web/data/yjs/canvas-space', () => ({
  addReply: (...a: unknown[]) => addReply(...a),
  editAnnotationBody: (...a: unknown[]) => editAnnotationBody(...a),
  editReply: (...a: unknown[]) => editReply(...a),
  removeReply: () => undefined,
  runCanvasUndoBatch: (_p: string, _s: string, _o: unknown, write: () => void) => {
    write();
    return { ok: true };
  },
}));

const roster = vi.hoisted(() => ({
  members: [
    { userId: 'u-me', name: 'Mika' },
    { userId: 'u-them', name: 'Rafa' },
  ],
}));

vi.mock('@web/data/use-project-members', () => ({
  useProjectMembers: () => ({ members: roster.members, isLoading: false, isError: false, retry: () => undefined }),
}));

const NAMES = new Map([
  ['u-me', { id: 'u-me', name: 'Mika', email: '' }],
  ['u-them', { id: 'u-them', name: 'Rafa', email: '' }],
]);

const RAFA = { userId: 'u-them', projectId: 'p1', mentionedAt: 1, label: '@Rafa' };

/**
 * Wrap a canvas piece in what a node lives inside.
 * @param children - The piece.
 * @returns The tree.
 */
const inCanvas = (children: React.ReactNode): React.JSX.Element => (
  <CanvasContext.Provider
    value={{ projectId: 'p1', spaceId: 's1', readOnly: false, myRole: 'editor', caretProvider: null }}
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
      <AnnotationNamesContext.Provider value={NAMES}>{children}</AnnotationNamesContext.Provider>
    </CanvasActionsContext.Provider>
  </CanvasContext.Provider>
);

/**
 * A sticky by me.
 * @param over - Fields to change.
 * @returns The view.
 */
const sticky = (over: Partial<AnnotationNodeView> = {}): AnnotationNodeView => ({
  content: 'a cooler shot here',
  createdBy: 'u-me',
  createdAt: 1,
  replies: [],
  ...over,
});

/**
 * Type into a box with the caret at the end.
 * @param box - The box.
 * @param value - The words.
 */
function typeInto(box: HTMLElement, value: string): void {
  fireEvent.change(box, { target: { value } });
  (box as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
  fireEvent.keyUp(box);
}

beforeEach(() => {
  useCanvasStore.getState().reset();
  canvasSessions.clear();
  vi.clearAllMocks();
  addReply.mockReturnValue(true);
  editAnnotationBody.mockReturnValue(true);
  editReply.mockReturnValue(true);
  roster.members = [
    { userId: 'u-me', name: 'Mika' },
    { userId: 'u-them', name: 'Rafa' },
  ];
  useCurrentUserStore.setState({ user: { id: 'u-me' } as never });
});

describe('a reply that mentions a member', () => {
  it('writes the picked member beside the words', () => {
    render(inCanvas(<AnnotationSticky data={sticky()} nodeId='n1' />));
    const box = screen.getByTestId('annotation-sticky-reply-input');
    typeInto(box, '@Ra');
    fireEvent.click(screen.getByTestId('mention-picker-member-u-them'));
    expect(box).toHaveValue('@Rafa ');
    typeInto(box, '@Rafa have a look');
    fireEvent.click(screen.getByTestId('annotation-sticky-reply-post'));
    expect(addReply).toHaveBeenCalledWith(
      'p1',
      's1',
      'n1',
      expect.objectContaining({
        content: '@Rafa have a look',
        mentions: [expect.objectContaining({ userId: 'u-them', projectId: 'p1', label: '@Rafa' })],
      }),
    );
  });

  it('writes no mentions for a member whose name was typed away before posting', () => {
    render(inCanvas(<AnnotationSticky data={sticky()} nodeId='n1' />));
    const box = screen.getByTestId('annotation-sticky-reply-input');
    typeInto(box, '@');
    fireEvent.click(screen.getByTestId('mention-picker-member-u-them'));
    typeInto(box, 'never mind');
    fireEvent.click(screen.getByTestId('annotation-sticky-reply-post'));
    expect(addReply.mock.calls[0][3]).not.toHaveProperty('mentions');
  });
});

describe('editing a note that mentions a member', () => {
  it('drops the mention once its words are deleted', async () => {
    const user = userEvent.setup();
    render(inCanvas(<AnnotationSticky data={sticky({ content: '@Rafa look', mentions: [RAFA] })} nodeId='n1' />));
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-sticky-body-input'), { target: { value: 'look' } });
    await user.click(screen.getByTestId('annotation-sticky-body-save'));
    expect(editAnnotationBody).toHaveBeenCalledWith('p1', 's1', 'n1', 'look', expect.any(Number), []);
  });

  it('keeps the mention of a member renamed since, by their new name', async () => {
    roster.members = [{ userId: 'u-them', name: 'Rafael' }];
    const user = userEvent.setup();
    render(inCanvas(<AnnotationSticky data={sticky({ content: 'see this', mentions: [RAFA] })} nodeId='n1' />));
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-sticky-body-input'), { target: { value: '@Rafael see this' } });
    await user.click(screen.getByTestId('annotation-sticky-body-save'));
    expect(editAnnotationBody).toHaveBeenCalledWith('p1', 's1', 'n1', '@Rafael see this', expect.any(Number), [RAFA]);
  });

  it('opens the reply edit box with the @ list', async () => {
    const user = userEvent.setup();
    const reply = { id: 'r1', content: 'hmm', createdBy: 'u-me', createdAt: 2 };
    render(inCanvas(<AnnotationSticky data={sticky({ replies: [reply] })} nodeId='n1' />));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));
    const box = screen.getByTestId('annotation-sticky-reply-r1-input');
    typeInto(box, 'hmm @');
    fireEvent.click(screen.getByTestId('mention-picker-member-u-them'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-save'));
    expect(editReply).toHaveBeenCalledWith(
      'p1',
      's1',
      'n1',
      'r1',
      'hmm @Rafa ',
      expect.any(Number),
      [expect.objectContaining({ userId: 'u-them' })],
    );
  });
});

describe('a new note that mentions a member', () => {
  it('hands the picked member over with the words', () => {
    const onCommit = vi.fn(() => true);
    render(inCanvas(<AnnotationComposer onCommit={onCommit} onClose={() => undefined} />));
    const box = screen.getByTestId('annotation-composer-input');
    typeInto(box, 'ask @');
    fireEvent.click(screen.getByTestId('mention-picker-member-u-them'));
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('ask @Rafa ', [expect.objectContaining({ userId: 'u-them' })]);
  });
});
