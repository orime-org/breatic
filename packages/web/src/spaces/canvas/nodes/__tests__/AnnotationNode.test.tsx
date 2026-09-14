// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { setLocale, type ProjectRole } from '@breatic/shared';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';
import {
  NOTE_BOX_MAX_HEIGHT,
  NOTE_REGION_MAX_HEIGHT,
} from '@web/spaces/canvas/annotation/caps';
import { AnnotationNamesContext } from '@web/spaces/canvas/annotation/names';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { useCanvasStore } from '@web/stores/canvas';
import { useCurrentUserStore } from '@web/stores/current-user';

const addReply = vi.fn();
const editAnnotationBody = vi.fn();
const editReply = vi.fn();
const removeReply = vi.fn();
const deleteNode = vi.fn();

vi.mock('@web/data/yjs/canvas-space', () => ({
  addReply: (...a: unknown[]) => addReply(...a),
  editAnnotationBody: (...a: unknown[]) => editAnnotationBody(...a),
  editReply: (...a: unknown[]) => editReply(...a),
  removeReply: (...a: unknown[]) => removeReply(...a),
}));

// What the board resolved for everybody its stickies name. The roster is
// deliberately NOT what names an author: it holds only people still on the
// project, so resolving through it makes a departed author's notes go
// anonymous — the one thing A11 says must not happen (design §4.1).
const NAMES = new Map([
  ['u-me', { id: 'u-me', name: 'Mika', email: '' }],
  ['u-them', { id: 'u-them', name: 'Rafa', email: '' }],
  // Somebody who wrote a note and later left the project. The roster no longer
  // lists them; the account endpoint still answers.
  ['u-gone', { id: 'u-gone', name: 'Ines', email: '' }],
]);

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
      <CanvasActionsContext.Provider
        value={{
          renameNode: () => undefined,
          deleteEdge: () => undefined,
          deleteNode,
          activateNodeUpload: () => undefined,
          commitGroupResize: () => undefined,
          reportGroupResize: () => undefined,
          beginGroupResize: () => undefined,
        }}
      >
        <AnnotationNamesContext.Provider value={NAMES}>
          <NodeIdContext.Provider value='n1'>
            <AnnotationNode data={data} locked={locked} />
          </NodeIdContext.Provider>
        </AnnotationNamesContext.Provider>
      </CanvasActionsContext.Provider>
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

// A draft lives in the canvas store now, which is what lets it outlive the
// node's DOM (#1881 E7). It outlives a test case too, so each one starts from
// a canvas with no box open.
beforeEach(() => {
  useCanvasStore.getState().reset();
});

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
    // The order this case is named for. Presence alone holds either way round.
    expect(screen.getByTestId('annotation-node-replies').textContent).toMatch(
      /agreed[\s\S]*and shorter/,
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

  it('lets an owner clear the board without rewriting what it says', async () => {
    // A8: an owner may remove anyone's words. A6: editing follows authorship
    // alone, owner or not — a reply further down was written against these
    // words. Both answers are in the one menu.
    const user = userEvent.setup();
    mount(sticky({ createdBy: THEM }), 'owner');
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    expect(
      screen.getByTestId('annotation-node-body-delete'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-node-body-edit')).toBeNull();
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

  it('keeps the reply when Escape only dismisses an IME candidate window', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.focus(box);
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveValue('镜头');
  });

  it('keeps a rewrite when Escape only dismisses an IME candidate window', async () => {
    const user = userEvent.setup();
    mount(sticky({ content: 'a cooler shot here' }));
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    const box = screen.getByTestId('annotation-node-body-input');
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByTestId('annotation-node-body-input')).toHaveValue('镜头');
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

  it('refuses a blank rewrite in a way the author can see', async () => {
    // Blanking a note is not deleting it, so the reducer keeps the box open
    // and writes nothing — correct, and it used to happen in total silence:
    // Save looked pressable, the click did nothing, and the box just sat
    // there. The reply box's Post button already answers this condition.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-node-body-input'), {
      target: { value: '   ' },
    });
    expect(screen.getByTestId('annotation-node-body-save')).toBeDisabled();
    expect(editAnnotationBody).not.toHaveBeenCalled();
  });

  it('leaves no way to delete the reply you are rewriting', async () => {
    // The "this was deleted" notice explains a REMOTE removal, and it can only
    // stay true while your own Delete is out of reach: raised against your own
    // deletion it would report your action back to you as something that had
    // befallen you. With every entry point down while a box is open, the one
    // that could do that is gone.
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-node-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-node-reply-r1-edit'));
    expect(screen.getByTestId('annotation-node-reply-r1-input')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-node-reply-r1-menu')).toBeNull();
    expect(screen.queryByTestId('annotation-node-reply-r1-delete')).toBeNull();
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

  it('keeps a half-typed reply when the press lands beside the box', () => {
    // The row is padding, a gap and the Post button around the textarea, and
    // a press on any of it moves focus to <body>, which blurs the box and
    // discards a reply nobody has posted yet. The Post button used to guard
    // its own surface; the row guards all of them.
    mount(sticky());
    const box = screen.getByTestId('annotation-node-reply-input');
    fireEvent.change(box, { target: { value: 'half a thought' } });
    const row = box.parentElement;
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row?.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
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

  it('takes the box away when the lock arrives mid-rewrite', async () => {
    // The lock reached the entry points and stopped there: the menu and the
    // reply box went, and the open edit box, its Save and its Cancel stayed.
    // Save wrote the new body into the locked node — the border the lock was
    // added here to stop it reaching.
    const user = userEvent.setup();
    const { rerender } = mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-node-body-input'), {
      target: { value: 'rewritten while it was being locked' },
    });
    rerender(inCanvas(sticky(), 'editor', true));
    expect(screen.queryByTestId('annotation-node-body-input')).toBeNull();
    expect(editAnnotationBody).not.toHaveBeenCalled();
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

  /**
   * Assert something scrolls inside a `ScrollArea` of ours, not by itself.
   *
   * Every visible scroller in this app belongs to `ScrollArea`
   * (packages/web/CLAUDE.md): a browser draws its own a different shape in
   * every engine. Looking outwards from the inner element would not settle it
   * inside a sticky — the thread is itself a `ScrollArea`, so an entry being
   * rewritten in it would find the thread's viewport and look handled while
   * scrolling itself. Naming the scroller says which one was meant.
   * @param scroller - Test id of the `ScrollArea` that should hold it.
   * @param inner - Selector for what must not scroll itself, within it.
   * @param cap - The max-height class, which belongs on the viewport: put on
   *   the Root it clips the content instead of scrolling it.
   */
  function scrollsInsideOurs(
    scroller: string,
    inner: string,
    cap: string,
  ): void {
    const viewport = screen
      .getByTestId(scroller)
      .querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport?.className).toContain(cap);
    expect(viewport?.querySelector(inner)).not.toBeNull();
  }

  it('scrolls a long body rather than growing the note past the screen', () => {
    // Nothing caps what somebody may paste in: measured, 10800 characters
    // made a 200px note 6487px tall, a landmark on the board that reached
    // well past the viewport in both directions.
    mount(sticky({ content: 'a cooler shot here\n\n'.repeat(400) }));
    scrollsInsideOurs(
      'annotation-node-body-scroller',
      '.annotation-body',
      NOTE_REGION_MAX_HEIGHT,
    );
  });

  it('never lets the reply box scroll itself', () => {
    mount(sticky());
    scrollsInsideOurs(
      'annotation-node-reply-scroller',
      '[data-testid="annotation-node-reply-input"]',
      NOTE_BOX_MAX_HEIGHT,
    );
    // Always as tall as what is written, so there is nothing to scroll past.
    expect(
      screen.getByTestId('annotation-node-reply-input').style.height,
    ).not.toBe('');
  });

  it('never lets the box that rewrites the body scroll itself', async () => {
    // The body's own scroller carries whichever of the two is showing: the
    // words, or the box rewriting them. They are never both there.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    scrollsInsideOurs(
      'annotation-node-body-scroller',
      '[data-testid="annotation-node-body-input"]',
      NOTE_REGION_MAX_HEIGHT,
    );
    expect(
      screen.getByTestId('annotation-node-body-input').style.height,
    ).not.toBe('');
  });

  it('puts the caret in the box it opens', async () => {
    // The person asked to rewrite this; the caret belongs in the box they
    // asked for, not wherever the menu item left it.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    expect(screen.getByTestId('annotation-node-body-input')).toHaveFocus();
  });

  it('leaves the caret alone when a sticky comes back with its box open', async () => {
    // The draft outlives the node's DOM on purpose, so a sticky panned back
    // into view mounts with its box already open. Focusing on that mount takes
    // the caret out of whatever the reader is typing in elsewhere on the
    // board, and a reply box loses its words on blur -- measured with two
    // stickies: the caret landed in the returning note's edit box and half a
    // reply on the other sticky was gone.
    const user = userEvent.setup();
    const view = mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-edit'));
    view.unmount();
    mount(sticky());
    expect(screen.getByTestId('annotation-node-body-input')).not.toHaveFocus();
  });

  it('writes a rewritten reply back to that reply, not over the body', async () => {
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'one', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-node-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-node-reply-r1-edit'));
    const box = screen.getByTestId('annotation-node-reply-r1-input');
    await user.clear(box);
    await user.type(box, 'one, reworded');
    await user.click(screen.getByTestId('annotation-node-reply-r1-save'));
    expect(editReply).toHaveBeenCalledWith(
      'p1',
      's1',
      'n1',
      'r1',
      'one, reworded',
      expect.any(Number),
    );
    expect(editAnnotationBody).not.toHaveBeenCalled();
  });

  it('asks the canvas to remove the sticky, rather than writing it away', async () => {
    // The canvas owns the guard every other delete entry point goes through.
    // A lock on the GROUP this sticky belongs to freezes its members, and a
    // member is handed only its own `data.locked` — so a delete written from
    // here would answer differently from the Delete key on the same node.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-node-body-menu'));
    await user.click(screen.getByTestId('annotation-node-body-delete'));
    expect(deleteNode).toHaveBeenCalledWith('n1');
  });

  it('keeps an open box through the node leaving the screen and coming back', async () => {
    // The canvas runs with `onlyRenderVisibleElements`, which unmounts an
    // offscreen node's DOM while the node itself stays in the document.
    // Measured on a real board: two screens of pan away and back left the box
    // closed and half a reply gone, with nothing said about it.
    const user = userEvent.setup();
    const view = mount(sticky());
    await user.type(
      screen.getByTestId('annotation-node-reply-input'),
      'not sent yet',
    );
    view.unmount();
    mount(sticky());
    expect(screen.getByTestId('annotation-node-reply-input')).toHaveValue(
      'not sent yet',
    );
  });

  it('never lets the box that rewrites a reply scroll itself', async () => {
    // A reply has no scroller of its own — the thread it sits in is one, and
    // nesting a second inside it would give the reader two nested scrollbars
    // for one column of words.
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'one', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-node-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-node-reply-r1-edit'));
    scrollsInsideOurs(
      'annotation-node-replies',
      '[data-testid="annotation-node-reply-r1-input"]',
      NOTE_REGION_MAX_HEIGHT,
    );
    expect(
      screen.getByTestId('annotation-node-reply-r1-input').style.height,
    ).not.toBe('');
  });
});
