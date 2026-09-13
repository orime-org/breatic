// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { setLocale, type ProjectRole } from '@breatic/shared';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { useCurrentUserStore } from '@web/stores/current-user';

const addReply = vi.fn();
const editAnnotationBody = vi.fn();
const editReply = vi.fn();
const removeReply = vi.fn();
const removeNode = vi.fn();

vi.mock('@web/data/yjs/canvas-space', () => ({
  addReply: (...a: unknown[]) => addReply(...a),
  editAnnotationBody: (...a: unknown[]) => editAnnotationBody(...a),
  editReply: (...a: unknown[]) => editReply(...a),
  removeReply: (...a: unknown[]) => removeReply(...a),
  removeNode: (...a: unknown[]) => removeNode(...a),
}));

vi.mock('@web/data/use-project-members', () => ({
  useProjectMembers: () => ({
    members: [
      { id: 'u-me', userId: 'u-me', name: 'Mika', email: '', role: 'editor' },
      {
        id: 'u-them',
        userId: 'u-them',
        name: 'Rafa',
        email: '',
        role: 'editor',
      },
    ],
    isLoading: false,
  }),
}));

const ME = 'u-me';
const THEM = 'u-them';
const NOW = 1_757_000_000_000;

/**
 * A sticky, with whatever the case needs changed.
 * @param over - Fields to override on the default sticky.
 * @returns The node view the component renders.
 */
const sticky = (over: Partial<AnnotationNodeView> = {}): AnnotationNodeView => ({
  kind: 'annotation',
  content: 'a cooler shot here',
  createdBy: ME,
  createdAt: NOW,
  replies: [],
  ...over,
});

/**
 * Wrap a sticky in the providers a canvas node lives inside.
 * @param data - The sticky to draw.
 * @param role - The viewer's role on the project.
 * @returns The element tree to render.
 */
const inCanvas = (
  data: AnnotationNodeView,
  role: ProjectRole,
): React.JSX.Element => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <CanvasContext.Provider
      value={{
        projectId: 'p1',
        spaceId: 's1',
        readOnly: role === 'viewer',
        myRole: role,
        caretProvider: null,
      }}
    >
      <NodeIdContext.Provider value='n1'>
        <AnnotationNode data={data} />
      </NodeIdContext.Provider>
    </CanvasContext.Provider>
  </QueryClientProvider>
);

/**
 * Mount a sticky.
 * @param data - The sticky to draw.
 * @param role - The viewer's role on the project.
 * @returns The render result.
 */
function mount(
  data: AnnotationNodeView,
  role: ProjectRole = 'editor',
): ReturnType<typeof render> {
  return render(inCanvas(data, role));
}

describe('a sticky on the canvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCurrentUserStore.setState({
      user: {
        id: ME,
        name: 'Mika',
        email: 'mika@example.com',
        personalStudio: null,
        membershipTier: 'base',
      },
    });
  });

  afterEach(() => {
    setLocale('en');
    useCurrentUserStore.setState({ user: null });
  });

  it('draws the body through the markdown renderer', () => {
    mount(sticky({ content: 'make it **slower**' }));
    const body = screen.getByTestId('annotation-node-body');
    expect(body.querySelector('strong')).toHaveTextContent('slower');
  });

  it('names the author from the project roster, not by user id', () => {
    mount(sticky({ createdBy: THEM }));
    expect(screen.getByTestId('annotation-node-body-author')).toHaveTextContent(
      'Rafa',
    );
    expect(screen.queryByText(THEM)).toBeNull();
  });

  it('marks a body that was rewritten', () => {
    mount(sticky({ editedAt: NOW + 1000 }));
    expect(
      screen.getByTestId('annotation-node-body-edited'),
    ).toBeInTheDocument();
  });

  it('leaves an untouched body unmarked', () => {
    mount(sticky());
    expect(screen.queryByTestId('annotation-node-body-edited')).toBeNull();
  });

  it('draws every reply, oldest first', () => {
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'agreed', createdBy: THEM, createdAt: NOW + 1 },
          {
            id: 'r2',
            content: 'and shorter',
            createdBy: ME,
            createdAt: NOW + 2,
          },
        ],
      }),
    );
    expect(screen.getByTestId('annotation-node-reply-r1')).toHaveTextContent(
      'agreed',
    );
    expect(screen.getByTestId('annotation-node-reply-r2')).toHaveTextContent(
      'and shorter',
    );
  });

  it('offers the menu on what this person wrote, and not on the rest', () => {
    mount(
      sticky({
        createdBy: ME,
        replies: [
          { id: 'r1', content: 'agreed', createdBy: THEM, createdAt: NOW + 1 },
        ],
      }),
    );
    expect(screen.getByTestId('annotation-node-body-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-node-reply-r1-menu')).toBeNull();
  });

  it('lets an owner reach the menu on words they did not write', () => {
    mount(sticky({ createdBy: THEM }), 'owner');
    expect(screen.getByTestId('annotation-node-body-menu')).toBeInTheDocument();
  });

  it('gives a viewer nothing to write with, and everything to read', () => {
    mount(sticky({ createdBy: ME }), 'viewer');
    expect(screen.queryByTestId('annotation-node-reply-input')).toBeNull();
    expect(screen.queryByTestId('annotation-node-body-menu')).toBeNull();
    expect(screen.getByTestId('annotation-node-body')).toHaveTextContent(
      'a cooler shot here',
    );
  });

  it('posts a reply on Enter', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'agreed, slower' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(addReply).toHaveBeenCalledTimes(1);
    expect(addReply.mock.calls[0]?.[3]).toMatchObject({
      content: 'agreed, slower',
      createdBy: ME,
    });
  });

  it('keeps the Enter that confirms an IME candidate to itself', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.focus(box);
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(addReply).not.toHaveBeenCalled();
  });

  it('throws a half-typed reply away on Escape', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'never mind' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(addReply).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('writes a rewritten body and stamps when', async () => {
    const user = userEvent.setup();
    mount(sticky({ content: 'a cooler shot here' }));
    // Radix opens on a full pointer sequence, which `fireEvent.click` is not.
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-node-body-input'), {
      target: { value: 'a cooler, slower shot' },
    });
    await user.click(screen.getByTestId('annotation-node-body-save'));
    expect(editAnnotationBody).toHaveBeenCalledWith(
      'p1',
      's1',
      'n1',
      'a cooler, slower shot',
      expect.any(Number),
    );
  });

  it('writes nothing when a rewrite is cancelled', async () => {
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-node-body-input'), {
      target: { value: 'never mind' },
    });
    await user.click(screen.getByTestId('annotation-node-body-cancel'));
    expect(editAnnotationBody).not.toHaveBeenCalled();
    expect(screen.queryByTestId('annotation-node-body-input')).toBeNull();
  });

  it('deletes one reply by id', async () => {
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-node-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-node-reply-r1-delete'));
    expect(removeReply).toHaveBeenCalledWith('p1', 's1', 'n1', 'r1');
  });

  it('says so when the reply being rewritten is deleted elsewhere', async () => {
    const user = userEvent.setup();
    const { rerender } = mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-node-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-node-reply-r1-edit'));
    expect(
      screen.getByTestId('annotation-node-reply-r1-input'),
    ).toBeInTheDocument();

    rerender(inCanvas(sticky({ replies: [] }), 'editor'));
    expect(
      screen.getByTestId('annotation-node-target-gone'),
    ).toBeInTheDocument();
    expect(editReply).not.toHaveBeenCalled();
  });

  it('says when in the language the reader chose', () => {
    // The sticky used to carry its own formatter, which said "5m ago" in every
    // language (#2155). It reads the shared one now, so the switch reaches it.
    const posted = Date.now() - 5 * 60_000;
    const { unmount } = mount(sticky({ createdAt: posted }));
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    unmount();

    setLocale('zh-CN');
    mount(sticky({ createdAt: posted }));
    expect(screen.queryByText('5 minutes ago')).toBeNull();
    expect(screen.getByText('5 分钟前')).toBeInTheDocument();
  });

  it('mounts the shell at the standalone width', () => {
    mount(sticky());
    expect(screen.getByTestId('annotation-node').className).toContain(
      'w-[200px]',
    );
  });
});
