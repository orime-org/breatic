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

// The roster is deliberately NOT what names an author: it holds only people
// still on the project, so resolving through it makes a departed author's notes
// go anonymous — the one thing A11 says must not happen (design §4.1).
vi.mock('@web/data/use-user-profiles', () => ({
  useUserProfiles: () =>
    new Map([
      ['u-me', { id: 'u-me', name: 'Mika', email: '' }],
      ['u-them', { id: 'u-them', name: 'Rafa', email: '' }],
      // Somebody who wrote a note and later left the project. The roster no
      // longer lists them; the account endpoint still answers.
      ['u-gone', { id: 'u-gone', name: 'Ines', email: '' }],
    ]),
}));

const ME = 'u-me';
const THEM = 'u-them';
/** Somebody who wrote a note and has since left the project (A11). */
const DEPARTED = 'u-gone';
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
 * @param locked - Whether the node carries `data.locked`.
 * @returns The element tree to render.
 */
const inCanvas = (
  data: AnnotationNodeView,
  role: ProjectRole,
  locked = false,
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
        <AnnotationNode data={data} locked={locked} />
      </NodeIdContext.Provider>
    </CanvasContext.Provider>
  </QueryClientProvider>
);

/**
 * Mount a sticky.
 * @param data - The sticky to draw.
 * @param role - The viewer's role on the project.
 * @param locked - Whether the node carries `data.locked`.
 * @returns The render result.
 */
function mount(
  data: AnnotationNodeView,
  role: ProjectRole = 'editor',
  locked = false,
): ReturnType<typeof render> {
  return render(inCanvas(data, role, locked));
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

  it('names the author, not their user id', () => {
    mount(sticky({ createdBy: THEM }));
    expect(screen.getByTestId('annotation-node-body-author')).toHaveTextContent(
      'Rafa',
    );
    expect(screen.queryByText(THEM)).toBeNull();
  });

  it('draws no avatar anywhere on the sticky', () => {
    // user 2026-09-14: a note carries the name, not the face. The 200px width
    // is the whole sticky, and a thread of answers spends it on faces that
    // repeat down the column while the words get what is left.
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'agreed', createdBy: THEM, createdAt: NOW + 1 },
        ],
      }),
    );
    // The Avatar root is the one element that clips a circle — `rounded-full`
    // and `overflow-hidden` together. The scroller's thumb is round without
    // clipping and its own root clips without being round, so neither is
    // mistaken for a portrait.
    const node = screen.getByTestId('annotation-node');
    expect(
      node.querySelector('[class*="rounded-full"][class*="overflow-hidden"]'),
    ).toBeNull();
    expect(node.querySelector('img')).toBeNull();
  });

  it('sends the time to the far side of the header', () => {
    // The name is short and the sticky is 200px, so everything packed to the
    // left leaves the right half of the header blank. The free space goes
    // between the name and the time, which puts the name at one edge and the
    // time at the other.
    mount(sticky({ editedAt: NOW + 1000 }));
    expect(screen.getByTestId('annotation-node-body-time').className).toContain(
      'ml-auto',
    );
    // Whatever follows the time rides along behind it rather than claiming the
    // space for itself — two elements each taking the leftover would put the
    // first one in the middle.
    expect(
      screen.getByTestId('annotation-node-body-edited').className,
    ).not.toContain('ml-auto');
    expect(
      screen.getByTestId('annotation-node-body-menu').className,
    ).not.toContain('ml-auto');
  });

  it('keeps naming an author who has left the project', () => {
    // A11 is explicit about this one, and the roster cannot answer it: it
    // holds who is on the project now, so resolving through it turns every
    // note a departed colleague wrote anonymous. Names come from the account
    // instead (design §4.1), which answers for anybody not soft-deleted.
    mount(sticky({ createdBy: DEPARTED }));
    expect(screen.getByTestId('annotation-node-body-author')).toHaveTextContent(
      'Ines',
    );
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

describe('one box at a time on a sticky', () => {
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
    useCurrentUserStore.setState({ user: null });
  });

  it('takes the reply box away while a rewrite is open', async () => {
    // §6.2's table says an entry point does not render while a box is open,
    // and everything else on this sticky rests on it. Left standing, the reply
    // box wrote into the rewrite's draft: the keystrokes never appeared in the
    // reply box, they replaced the body being rewritten, and Enter wrote them
    // over the note.
    const user = userEvent.setup();
    mount(sticky({ content: 'a cooler shot here' }));
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    expect(screen.getByTestId('annotation-node-body-input')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-node-reply-input')).toBeNull();
  });

  it('takes the open entry own menu away too, so Edit is never a no-op', async () => {
    // The entry being rewritten kept its own menu, and the Edit inside it did
    // nothing at all: the reducer refuses a second open on a live draft, so
    // the click landed on a command that could not act. Every entry point
    // steps aside; the box is the only one left.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    expect(screen.getByTestId('annotation-node-body-input')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-node-body-menu')).toBeNull();
  });

  it('leaves every menu alone while the reply box holds only a caret', () => {
    // Opening the draft on a bare focus took the menus away before a single
    // character existed: click into the reply box, reach for the note's ⋯ to
    // edit it, and there is no button there. What the entry points step aside
    // for is words that could be lost, and a caret is not that.
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    fireEvent.focus(screen.getByTestId('annotation-node-reply-input'));
    expect(screen.getByTestId('annotation-node-body-menu')).toBeInTheDocument();
    expect(
      screen.getByTestId('annotation-node-reply-r1-menu'),
    ).toBeInTheDocument();
  });

  it('still catches the Enter that confirms an IME candidate on a bare box', () => {
    // The draft opens on the composition rather than on the focus now, so the
    // gate that tells a candidate-picking Enter from a submitting one has to
    // be armed by the composition itself.
    mount(sticky());
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(addReply).not.toHaveBeenCalled();
  });

  it('takes the rewrite menus away while a reply is being typed', () => {
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'still typing' } });
    expect(screen.queryByTestId('annotation-node-body-menu')).toBeNull();
    expect(screen.queryByTestId('annotation-node-reply-r1-menu')).toBeNull();
  });

  it('answers twice in a row without the caret leaving the box', () => {
    // After Enter the draft closes while the caret stays where it was, so no
    // second focus event is coming. Waiting for one left the box dead: the
    // characters went nowhere, Post stayed disabled, and the only way out was
    // to click elsewhere and back.
    mount(sticky());
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(addReply).toHaveBeenCalledTimes(1);

    fireEvent.change(box, { target: { value: 'second' } });
    expect(box).toHaveValue('second');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(addReply).toHaveBeenCalledTimes(2);
    expect(addReply.mock.calls[1]?.[3]).toMatchObject({ content: 'second' });
  });
});

describe('a locked sticky', () => {
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
    useCurrentUserStore.setState({ user: null });
  });

  it('offers its author nothing to write with', () => {
    // A sticky is a node, and `data.locked` freezes a node's content, its name
    // and its existence — the canvas gate says so for every other kind, and
    // design §8.4 puts the sticky under the same rule. Its own controls used
    // to write straight to the document, so the lock stopped at the border.
    mount(sticky({ replies: [] }), 'editor', true);
    expect(screen.queryByTestId('annotation-node-body-menu')).toBeNull();
    expect(screen.queryByTestId('annotation-node-reply-input')).toBeNull();
  });

  it('offers an owner nothing either', () => {
    mount(sticky({ createdBy: THEM }), 'owner', true);
    expect(screen.queryByTestId('annotation-node-body-menu')).toBeNull();
  });

  it('locks the replies as well as the body', () => {
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
      'editor',
      true,
    );
    expect(screen.queryByTestId('annotation-node-reply-r1-menu')).toBeNull();
    expect(screen.getByTestId('annotation-node-reply-r1')).toHaveTextContent(
      'mine',
    );
  });

  it('still shows everything that was written', () => {
    mount(sticky({ content: 'a cooler shot here' }), 'editor', true);
    expect(screen.getByTestId('annotation-node-body')).toHaveTextContent(
      'a cooler shot here',
    );
  });
});

describe('the replies scroller', () => {
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
    useCurrentUserStore.setState({ user: null });
  });

  it('caps the element that actually scrolls, not the one around it', () => {
    // ScrollArea's contract puts height caps on the viewport. On the Root the
    // cap clips and nothing scrolls: measured on a board, ten replies gave a
    // 179px root over a 468px viewport whose scrollTop would not move off 0,
    // with 267px of thread unreachable.
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'one', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    const list = screen.getByTestId('annotation-node-replies');
    expect(list.className).not.toMatch(/max-h-/);
    const viewport = list.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport?.className).toMatch(/max-h-/);
  });

  it('keeps the canvas gestures off the thread', () => {
    // Without these the wheel over the replies zooms the board instead of
    // scrolling them, and dragging to select a line flings the note across it
    // — measured at 112px and 150px respectively.
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'one', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    expect(screen.getByTestId('annotation-node-replies').className).toContain(
      'nowheel',
    );
    expect(screen.getByTestId('annotation-node-replies').className).toContain(
      'nodrag',
    );
  });

  it('lets a pointer press select the body instead of dragging the note', () => {
    mount(sticky());
    expect(screen.getByTestId('annotation-node-body').className).toContain(
      'nodrag',
    );
  });
});
