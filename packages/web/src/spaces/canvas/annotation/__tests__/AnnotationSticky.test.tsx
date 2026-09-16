// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { setLocale, type ProjectRole } from '@breatic/shared';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { AnnotationSticky } from '@web/spaces/canvas/annotation/AnnotationSticky';
import {
  NOTE_BOX_MAX_HEIGHT,
  NOTE_MAX_CHARS,
  NOTE_REGION_MAX_HEIGHT,
} from '@web/spaces/canvas/annotation/caps';
import { AnnotationNamesContext } from '@web/spaces/canvas/annotation/names';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
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
          <AnnotationSticky data={data} nodeId='n1' locked={locked} />
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
  // The real writers answer whether the words landed, so the doubles have to
  // answer too — a double that returns `undefined` reads as "written nowhere"
  // and would put every save behind the notice. `clearAllMocks` in the suites
  // below keeps the call log clean without touching this.
  addReply.mockReturnValue(true);
  editAnnotationBody.mockReturnValue(true);
  editReply.mockReturnValue(true);
});

describe('Escape on a sticky with no box open', () => {
  it('reaches the canvas, which is what collapses the note', () => {
    // The sticky collapses when the note loses the selection, and Escape is
    // how the canvas clears it (§8.7.3). The reply box swallowed every Escape,
    // draft or no draft, so a reader whose caret was in it could not collapse
    // the note from the keyboard at all — measured on a board, twice.
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    const press = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    let reachedTheDocument = false;
    const listen = (): void => {
      reachedTheDocument = true;
    };
    document.addEventListener('keydown', listen);
    box.dispatchEvent(press);
    document.removeEventListener('keydown', listen);
    expect(reachedTheDocument).toBe(true);
  });
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
    const body = screen.getByTestId('annotation-sticky-body');
    expect(body.querySelector('strong')).toHaveTextContent('slower');
  });

  it('names the author, not their user id', () => {
    mount(sticky({ createdBy: THEM }));
    expect(screen.getByTestId('annotation-sticky-body-author')).toHaveTextContent(
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
    const node = screen.getByTestId('annotation-sticky');
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
    expect(screen.getByTestId('annotation-sticky-body-time').className).toContain(
      'ml-auto',
    );
    // Whatever follows the time rides along behind it rather than claiming the
    // space for itself — two elements each taking the leftover would put the
    // first one in the middle.
    expect(
      screen.getByTestId('annotation-sticky-body-edited').className,
    ).not.toContain('ml-auto');
    expect(
      screen.getByTestId('annotation-sticky-body-menu').className,
    ).not.toContain('ml-auto');
  });

  it('keeps naming an author who has left the project', () => {
    // A11 is explicit about this one, and the roster cannot answer it: it
    // holds who is on the project now, so resolving through it turns every
    // note a departed colleague wrote anonymous. Names come from the account
    // instead (design §4.1), which answers for anybody not soft-deleted.
    mount(sticky({ createdBy: DEPARTED }));
    expect(screen.getByTestId('annotation-sticky-body-author')).toHaveTextContent(
      'Ines',
    );
  });

  it('marks a body that was rewritten', () => {
    mount(sticky({ editedAt: NOW + 1000 }));
    expect(
      screen.getByTestId('annotation-sticky-body-edited'),
    ).toBeInTheDocument();
  });

  it('leaves an untouched body unmarked', () => {
    mount(sticky());
    expect(screen.queryByTestId('annotation-sticky-body-edited')).toBeNull();
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
    expect(screen.getByTestId('annotation-sticky-reply-r1')).toHaveTextContent(
      'agreed',
    );
    expect(screen.getByTestId('annotation-sticky-reply-r2')).toHaveTextContent(
      'and shorter',
    );
    // The order this case is named for. Presence alone holds either way round.
    expect(screen.getByTestId('annotation-sticky-replies').textContent).toMatch(
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
    expect(screen.getByTestId('annotation-sticky-body-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-sticky-reply-r1-menu')).toBeNull();
  });

  it('lets an owner clear the board without rewriting what it says', async () => {
    // A8: an owner may remove anyone's words. A6: editing follows authorship
    // alone, owner or not — a reply further down was written against these
    // words. Both answers are in the one menu.
    const user = userEvent.setup();
    mount(sticky({ createdBy: THEM }), 'owner');
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    expect(
      screen.getByTestId('annotation-sticky-body-delete'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-sticky-body-edit')).toBeNull();
  });

  it('gives a viewer nothing to write with, and everything to read', () => {
    mount(sticky({ createdBy: ME }), 'viewer');
    expect(screen.queryByTestId('annotation-sticky-reply-input')).toBeNull();
    expect(screen.queryByTestId('annotation-sticky-body-menu')).toBeNull();
    expect(screen.getByTestId('annotation-sticky-body')).toHaveTextContent(
      'a cooler shot here',
    );
  });

  it('posts a reply on Enter', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
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
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(addReply).not.toHaveBeenCalled();
  });

  it('leaves a reply keystroke to the IME that reports owning it', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(addReply).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(box).toHaveValue('镜头');
  });

  it('throws a half-typed reply away on Escape', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'never mind' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(addReply).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('shows no post button until the reply has something in it', () => {
    // The demo's reply row is one full-width box and nothing else; a button
    // that is disabled whenever the box is empty spends the note's width on
    // an affordance that cannot be used.
    mount(sticky());
    expect(screen.queryByTestId('annotation-sticky-reply-post')).toBeNull();
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'agreed' } });
    expect(screen.getByTestId('annotation-sticky-reply-post')).toBeInTheDocument();
  });

  it('offers cancel beside post, in that order', () => {
    // The rewrite box pairs the two; a reply had a visible way to keep the
    // words and none to drop them, leaving Escape — which nothing on screen
    // mentions — as the only way out.
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'agreed' } });
    const cancel = screen.getByTestId('annotation-sticky-reply-cancel');
    const post = screen.getByTestId('annotation-sticky-reply-post');
    expect(
      cancel.compareDocumentPosition(post) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Document order is the order on screen only while the row runs the way
    // the writing does: `flex-row-reverse` would put cancel on the right with
    // the markup untouched, and jsdom lays nothing out to catch it.
    expect(cancel.parentElement?.className).not.toContain('flex-row-reverse');
    expect(cancel.parentElement?.className).not.toContain('flex-col');
  });

  it('drops the reply on cancel, writing nothing', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'never mind' } });
    fireEvent.click(screen.getByTestId('annotation-sticky-reply-cancel'));
    expect(addReply).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('posts the reply on the post button, not only on Enter', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'agreed, slower' } });
    fireEvent.click(screen.getByTestId('annotation-sticky-reply-post'));
    expect(addReply).toHaveBeenCalledTimes(1);
    expect(addReply.mock.calls[0]?.[3]).toMatchObject({
      content: 'agreed, slower',
      createdBy: ME,
    });
  });

  it('stacks the post button under the box rather than beside it', () => {
    // Beside it, the button took a third of a 200px note's width from the box
    // and left a 34px box next to a 24px button. The rewrite box two
    // components over already stacks its own buttons.
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'agreed' } });
    const button = screen.getByTestId('annotation-sticky-reply-post');
    const scroller = screen.getByTestId('annotation-sticky-reply-scroller');
    expect(scroller.contains(button)).toBe(false);
    // Same parent column, button after the box — not siblings on a flex row.
    const column = scroller.parentElement;
    expect(column?.contains(button)).toBe(true);
    expect(column?.className).toContain('flex-col');
  });

  it('keeps the reply when Escape only dismisses an IME candidate window', () => {
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(box).toHaveValue('镜头');
  });

  it('keeps a rewrite when Escape only dismisses an IME candidate window', async () => {
    const user = userEvent.setup();
    mount(sticky({ content: 'a cooler shot here' }));
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    const box = screen.getByTestId('annotation-sticky-body-input');
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(screen.getByTestId('annotation-sticky-body-input')).toHaveValue('镜头');
  });

  it('writes a rewritten body and stamps when', async () => {
    const user = userEvent.setup();
    mount(sticky({ content: 'a cooler shot here' }));
    // Radix opens on a full pointer sequence, which `fireEvent.click` is not.
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-sticky-body-input'), {
      target: { value: 'a cooler, slower shot' },
    });
    await user.click(screen.getByTestId('annotation-sticky-body-save'));
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
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-sticky-body-input'), {
      target: { value: 'never mind' },
    });
    await user.click(screen.getByTestId('annotation-sticky-body-cancel'));
    expect(editAnnotationBody).not.toHaveBeenCalled();
    expect(screen.queryByTestId('annotation-sticky-body-input')).toBeNull();
  });

  it('writes no rewrite while an IME is composing', async () => {
    // The rewrite box's Save is the second of the two controls that could
    // commit un-converted syllables; §6.2's criterion covers it too.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    const box = screen.getByTestId('annotation-sticky-body-input');
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'nihao' } });
    await user.click(screen.getByTestId('annotation-sticky-body-save'));
    expect(editAnnotationBody).not.toHaveBeenCalled();

    fireEvent.compositionEnd(box);
    await user.click(screen.getByTestId('annotation-sticky-body-save'));
    expect(editAnnotationBody).toHaveBeenCalledTimes(1);
  });

  it('refuses a blank rewrite and leaves the box open', async () => {
    // Blanking a note is not deleting it, so the reducer keeps the box open
    // and writes nothing; the empty box with its Cancel beside it is the
    // account of that. Save stays pressable, per repo rule #1945: a disabled
    // control says the reader did something wrong, and an empty box is not
    // wrong.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    const box = screen.getByTestId('annotation-sticky-body-input');
    fireEvent.change(box, { target: { value: '   ' } });
    const save = screen.getByTestId('annotation-sticky-body-save');
    expect(save).not.toBeDisabled();
    await user.click(save);
    expect(editAnnotationBody).not.toHaveBeenCalled();
    expect(screen.getByTestId('annotation-sticky-body-input')).toBeInTheDocument();
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
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));
    expect(screen.getByTestId('annotation-sticky-reply-r1-input')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-sticky-reply-r1-menu')).toBeNull();
    expect(screen.queryByTestId('annotation-sticky-reply-r1-delete')).toBeNull();
  });

  it('leaves every other entry its menu while a reply is being composed', async () => {
    // One character in the reply box used to take the menu off the whole
    // sticky. What the open box rules out is a SECOND box, so only the entry
    // it belongs to owes anything — and a new reply belongs to none of them.
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.type(screen.getByTestId('annotation-sticky-reply-input'), 'half');
    expect(screen.getByTestId('annotation-sticky-body-menu')).toBeInTheDocument();
    expect(
      screen.getByTestId('annotation-sticky-reply-r1-menu'),
    ).toBeInTheDocument();
  });

  it('offers Delete but not Edit on the entries the box does not belong to', async () => {
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));

    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    expect(
      screen.getByTestId('annotation-sticky-reply-r1-delete'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-sticky-reply-r1-edit')).toBeNull();
  });

  it('takes Delete off the reply being rewritten and off no other', async () => {
    // Which reply the box belongs to is an id, not a kind: the notice would
    // report the reader's own deletion back to them, and it can only say that
    // about the one entry they have open.
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
          { id: 'r2', content: 'also mine', createdBy: ME, createdAt: NOW + 2 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));

    expect(screen.queryByTestId('annotation-sticky-reply-r1-menu')).toBeNull();
    await user.click(screen.getByTestId('annotation-sticky-reply-r2-menu'));
    expect(
      screen.getByTestId('annotation-sticky-reply-r2-delete'),
    ).toBeInTheDocument();
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
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-delete'));
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
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));
    expect(
      screen.getByTestId('annotation-sticky-reply-r1-input'),
    ).toBeInTheDocument();

    rerender(inCanvas(sticky({ replies: [] }), 'editor'));
    expect(
      screen.getByTestId('annotation-sticky-drop-notice'),
    ).toHaveTextContent('This reply was deleted.');
    expect(editReply).not.toHaveBeenCalled();
  });

  it('says so when the words reached nobody', async () => {
    // The entry can go between the last render and the keystroke that saves,
    // so the writer's answer is the only account of where the words went: the
    // effect above fires off a render, and by then the box is already closed.
    const user = userEvent.setup();
    editReply.mockReturnValue(false);
    mount(
      sticky({
        replies: [
          { id: 'r1', content: 'mine', createdBy: ME, createdAt: NOW + 1 },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));
    await user.type(
      screen.getByTestId('annotation-sticky-reply-r1-input'),
      ' too',
    );
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-save'));
    expect(editReply).toHaveBeenCalled();
    expect(screen.getByTestId('annotation-sticky-drop-notice')).toHaveTextContent(
      'This reply was deleted.',
    );
  });

  it('says so when the right to write is taken away mid-draft', async () => {
    const user = userEvent.setup();
    const { rerender } = mount(sticky());
    await user.type(
      screen.getByTestId('annotation-sticky-reply-input'),
      'half an answer',
    );

    rerender(inCanvas(sticky(), 'editor', true));
    expect(screen.getByTestId('annotation-sticky-drop-notice')).toHaveTextContent(
      'You can no longer write here.',
    );
    expect(addReply).not.toHaveBeenCalled();
  });

  it('leaves the notice row out of the sticky\'s drag surface', async () => {
    // Every other row on this sticky carries `nodrag`, and the one that does
    // not was measured moving a note 112px on a real board. This row holds a
    // line somebody may want to read and a button they have to press.
    const user = userEvent.setup();
    const { rerender } = mount(sticky());
    await user.type(
      screen.getByTestId('annotation-sticky-reply-input'),
      'half an answer',
    );
    rerender(inCanvas(sticky(), 'editor', true));

    expect(screen.getByTestId('annotation-sticky-drop-notice').className).toContain(
      'nodrag',
    );
  });

  it('takes the notice away when the reader dismisses it', async () => {
    const user = userEvent.setup();
    const { rerender } = mount(sticky());
    await user.type(
      screen.getByTestId('annotation-sticky-reply-input'),
      'half an answer',
    );
    rerender(inCanvas(sticky(), 'editor', true));

    await user.click(screen.getByTestId('annotation-sticky-drop-dismiss'));
    expect(screen.queryByTestId('annotation-sticky-drop-notice')).toBeNull();
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
    expect(screen.getByTestId('annotation-sticky').className).toContain(
      'w-[200px]',
    );
  });

  it('rounds its corners the way the box it grew out of does', () => {
    // A note is chrome, so it takes the fixed chrome radius rather than the
    // content one that answers the Tweaks scale (user 2026-09-16). The two
    // resolve to 6px at the Round step the product locks, so what this holds
    // is the pairing: the placing box carries `rounded-chrome`
    // (`AnnotationComposer.tsx`), and the sticky Enter turns it into has to
    // carry the same one, or a moved content radius would round one and not
    // the other inside a single note.
    mount(sticky());
    expect(screen.getByTestId('annotation-sticky').className).toContain(
      'rounded-chrome',
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
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    expect(screen.getByTestId('annotation-sticky-body-input')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-sticky-reply-input')).toBeNull();
  });

  it('takes the open entry own menu away too, so Edit is never a no-op', async () => {
    // The entry being rewritten kept its own menu, and the Edit inside it did
    // nothing at all: the reducer refuses a second open on a live draft, so
    // the click landed on a command that could not act. Every entry point
    // steps aside; the box is the only one left.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    expect(screen.getByTestId('annotation-sticky-body-input')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-sticky-body-menu')).toBeNull();
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
    fireEvent.focus(screen.getByTestId('annotation-sticky-reply-input'));
    expect(screen.getByTestId('annotation-sticky-body-menu')).toBeInTheDocument();
    expect(
      screen.getByTestId('annotation-sticky-reply-r1-menu'),
    ).toBeInTheDocument();
  });

  it('still catches the candidate-picking Enter on a box nobody opened yet', () => {
    // The first character opens the draft, so this box reaches the gate by a
    // different route than one already being written in. The gate reads the
    // keystroke either way.
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(addReply).not.toHaveBeenCalled();
  });

  it('keeps the reply while the keyboard walks onto its own buttons', async () => {
    // Cancel and Post sit after the box in the tab order, and the box used to
    // discard the reply on any blur at all — so the first Tab threw the words
    // away and took both buttons off screen with them. Reaching a control with
    // the keyboard is the only way there without a mouse.
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    await user.type(box, 'half an answer');

    await user.tab();
    expect(screen.getByTestId('annotation-sticky-reply-cancel')).toHaveFocus();
    expect(box).toHaveValue('half an answer');

    await user.tab();
    expect(screen.getByTestId('annotation-sticky-reply-post')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(addReply).toHaveBeenCalledWith(
      'p1',
      's1',
      'n1',
      expect.objectContaining({ content: 'half an answer' }),
    );
  });

  it('keeps a half-typed reply when the focus leaves the row', async () => {
    // What ends a reply is the sticky closing, not the caret going somewhere
    // else (user 2026-09-15, §6.2's blur row): the sticky is a thing the
    // reader opened and can shut, and pressing the note's own words to select
    // one is not shutting it. Nothing is written until Post.
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    await user.type(box, 'half an answer');
    await user.click(screen.getByTestId('annotation-sticky-body'));
    expect(box).toHaveValue('half an answer');
    expect(addReply).not.toHaveBeenCalled();
  });

  it('is no box once the words are gone, so the note takes Edit back', async () => {
    // The box opens on the first character, and erasing the last one leaves
    // nothing anybody is writing. Measured before this: the draft stayed
    // `typing` with no Cancel on screen (it draws only once something is
    // typed) and no way out — `offeredWhileBoxOpen` had taken Edit off the
    // body and every reply, collapsing and reopening kept the draft, and the
    // reader was left with a note they could delete but not edit.
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    await user.type(box, 'a');
    await user.clear(box);

    expect(useCanvasStore.getState().annotationDrafts['n1']).toBeUndefined();
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    expect(screen.getByTestId('annotation-sticky-body-edit')).toBeInTheDocument();
  });

  it('holds no draft for whitespace, so the note keeps Edit', async () => {
    // "Is somebody writing in this box" has one answer, and it is the one the
    // reducer already uses to decide whether the words are worth writing.
    // Asked three ways instead, the bands between them were states nothing was
    // designed for: a single space opened a draft, which stands every entry
    // point down (§6.2), so Rewrite went off the body and off every reply
    // while the row that could have undone it stayed hidden.
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    await user.type(box, ' ');

    expect(useCanvasStore.getState().annotationDrafts['n1']).toBeUndefined();
    expect(screen.queryByTestId('annotation-sticky-reply-post')).toBeNull();
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    expect(screen.getByTestId('annotation-sticky-body-edit')).toBeInTheDocument();
  });

  it('never disables a button inside the row that holds the caret', async () => {
    // A disabled control dispatches no pointer events, so the row's press
    // guard cannot see the press and the caret lands on `<body>` — where the
    // canvas answers Backspace by deleting the selected node, which is this
    // note and its whole thread. Measured: pressing a disabled button leaves
    // `document.activeElement` as BODY, pressing an enabled one leaves it on
    // the textarea. #1945's rule: something must happen on this press (the
    // caret must stay), so it cannot be HTML `disabled`.
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    await user.type(box, 'a');
    expect(screen.getByTestId('annotation-sticky-reply-post')).not.toBeDisabled();
    expect(screen.getByTestId('annotation-sticky-reply-cancel')).not.toBeDisabled();
  });

  it('writes nothing while an IME is composing, whichever control is pressed', async () => {
    // §6.2's one criterion: `isComposing` true means do not commit. It was on
    // the Enter key only, so the two buttons beside the box could commit the
    // raw syllables a CJK reader had not picked a candidate for yet.
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'nihao' } });
    await user.click(screen.getByTestId('annotation-sticky-reply-post'));
    expect(addReply).not.toHaveBeenCalled();

    fireEvent.compositionEnd(box);
    await user.click(screen.getByTestId('annotation-sticky-reply-post'));
    expect(addReply).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when Cancel is pressed mid-composition', async () => {
    // Same criterion, same reason: the press belongs to the IME, so it ends
    // the candidate window rather than the reply.
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'nihao' } });
    await user.click(screen.getByTestId('annotation-sticky-reply-cancel'));
    expect(useCanvasStore.getState().annotationDrafts['n1']?.draft.text).toBe(
      'nihao',
    );
  });

  it('drops it on Cancel, which is the reader saying so', async () => {
    const user = userEvent.setup();
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
    await user.type(box, 'never mind');
    await user.click(screen.getByTestId('annotation-sticky-reply-cancel'));
    expect(box).toHaveValue('');
    expect(addReply).not.toHaveBeenCalled();
  });

  it('keeps a reply\'s rewrite buttons out of the thread\'s scroller too', async () => {
    // The body half of this was fixed; a reply's rewrite box grows without
    // bound inside a thread capped at 180px, so its Cancel and Save went
    // below the fold on exactly the same shape.
    const user = userEvent.setup();
    mount(
      sticky({
        replies: [
          {
            id: 'r1',
            content: 'a long reply. '.repeat(40),
            createdBy: ME,
            createdAt: NOW + 1,
          },
        ],
      }),
    );
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));

    const thread = screen.getByTestId('annotation-sticky-replies');
    const box = screen.getByTestId('annotation-sticky-reply-r1-input');
    const save = screen.getByTestId('annotation-sticky-reply-r1-save');
    // The box is capped by a scroller of its own; the buttons are outside it.
    const boxScroller = screen.getByTestId('annotation-sticky-reply-r1-scroller');
    expect(boxScroller).toContainElement(box);
    expect(boxScroller).not.toContainElement(save);
    // Both still live in the thread, which is the list they belong to.
    expect(thread).toContainElement(save);
  });

  it('keeps the rewrite buttons out of the scroller that caps the words', async () => {
    // The scroller caps the WORDS. With Cancel and Save swept into it, a note
    // long enough to fill the cap put both below the fold: the reader had to
    // scroll the box they were typing in to find the button that keeps it.
    const user = userEvent.setup();
    mount(sticky({ content: 'a long note. '.repeat(60) }));
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));

    const scroller = screen.getByTestId('annotation-sticky-body-scroller');
    expect(scroller).toContainElement(
      screen.getByTestId('annotation-sticky-body-input'),
    );
    expect(scroller).not.toContainElement(
      screen.getByTestId('annotation-sticky-body-save'),
    );
    expect(scroller).not.toContainElement(
      screen.getByTestId('annotation-sticky-body-cancel'),
    );
  });

  it('hands the caret back to the menu when a rewrite box closes', async () => {
    // The box takes the caret when it opens and used to drop it on the floor
    // when it closed: focus landed on <body>, where the canvas answers
    // Backspace by deleting whatever is selected.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    expect(screen.getByTestId('annotation-sticky-body-input')).toHaveFocus();

    await user.click(screen.getByTestId('annotation-sticky-body-cancel'));
    expect(screen.getByTestId('annotation-sticky-body-menu')).toHaveFocus();
  });

  it('opens a rewrite with the caret after the words, ready to carry on', async () => {
    // `focus()` does not move the selection (HTML, "focusing steps"), and a
    // textarea starts at offset 0, so the box opens with the caret ahead of
    // the body it was prefilled with and the next keystroke goes to the front
    // of the note. A rewrite starts from what is already written.
    const user = userEvent.setup();
    mount(sticky({ content: 'a cooler shot here' }));
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));

    const box = screen.getByTestId(
      'annotation-sticky-body-input',
    ) as HTMLTextAreaElement;
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe('a cooler shot here'.length);
    expect(box.selectionEnd).toBe('a cooler shot here'.length);
  });

  it('answers twice in a row without the caret leaving the box', () => {
    // After Enter the draft closes while the caret stays where it was, so no
    // second focus event is coming. Waiting for one left the box dead: the
    // characters went nowhere, Post stayed disabled, and the only way out was
    // to click elsewhere and back.
    mount(sticky());
    const box = screen.getByTestId('annotation-sticky-reply-input');
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
    expect(screen.queryByTestId('annotation-sticky-body-menu')).toBeNull();
    expect(screen.queryByTestId('annotation-sticky-reply-input')).toBeNull();
  });

  it('offers an owner nothing either', () => {
    mount(sticky({ createdBy: THEM }), 'owner', true);
    expect(screen.queryByTestId('annotation-sticky-body-menu')).toBeNull();
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
    expect(screen.queryByTestId('annotation-sticky-reply-r1-menu')).toBeNull();
    expect(screen.getByTestId('annotation-sticky-reply-r1')).toHaveTextContent(
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
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    fireEvent.change(screen.getByTestId('annotation-sticky-body-input'), {
      target: { value: 'rewritten while it was being locked' },
    });
    rerender(inCanvas(sticky(), 'editor', true));
    expect(screen.queryByTestId('annotation-sticky-body-input')).toBeNull();
    expect(editAnnotationBody).not.toHaveBeenCalled();
  });

  it('still shows everything that was written', () => {
    mount(sticky({ content: 'a cooler shot here' }), 'editor', true);
    expect(screen.getByTestId('annotation-sticky-body')).toHaveTextContent(
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

  it('refuses the 301st character in the reply box too', () => {
    // The third of a note's three boxes, and the only one that needs a whole
    // canvas around it to render — the other two are asserted in
    // `note-length.test.tsx`. Between them they cover the rule `caps.ts`
    // states: every box on a note takes the same number.
    mount(sticky());
    expect(screen.getByTestId('annotation-sticky-reply-input')).toHaveAttribute(
      'maxlength',
      String(NOTE_MAX_CHARS),
    );
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
    const list = screen.getByTestId('annotation-sticky-replies');
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
    expect(screen.getByTestId('annotation-sticky-replies').className).toContain(
      'nowheel',
    );
    expect(screen.getByTestId('annotation-sticky-replies').className).toContain(
      'nodrag',
    );
  });

  it('lets a pointer press select the body instead of dragging the note', () => {
    mount(sticky());
    expect(screen.getByTestId('annotation-sticky-body').className).toContain(
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
    // `NOTE_MAX_CHARS` bounds what goes into a box, not how tall the words
    // draw: 300 characters of short lines still stand taller than a note may.
    // Measured before the cap existed, at the extreme it guards against:
    // 10800 characters made a 200px note 6487px tall, a landmark on the board
    // that reached well past the viewport in both directions.
    mount(sticky({ content: 'a cooler shot here\n\n'.repeat(400) }));
    scrollsInsideOurs(
      'annotation-sticky-body-scroller',
      '.annotation-body',
      NOTE_REGION_MAX_HEIGHT,
    );
  });

  it('never lets the reply box scroll itself', () => {
    mount(sticky());
    scrollsInsideOurs(
      'annotation-sticky-reply-scroller',
      '[data-testid="annotation-sticky-reply-input"]',
      NOTE_BOX_MAX_HEIGHT,
    );
    // Always as tall as what is written, so there is nothing to scroll past.
    expect(
      screen.getByTestId('annotation-sticky-reply-input').style.height,
    ).not.toBe('');
  });

  it('never lets the box that rewrites the body scroll itself', async () => {
    // The body's own scroller carries whichever of the two is showing: the
    // words, or the box rewriting them. They are never both there.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    scrollsInsideOurs(
      'annotation-sticky-body-scroller',
      '[data-testid="annotation-sticky-body-input"]',
      NOTE_REGION_MAX_HEIGHT,
    );
    expect(
      screen.getByTestId('annotation-sticky-body-input').style.height,
    ).not.toBe('');
  });

  it('puts the caret in the box it opens', async () => {
    // The person asked to rewrite this; the caret belongs in the box they
    // asked for, not wherever the menu item left it.
    const user = userEvent.setup();
    mount(sticky());
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    expect(screen.getByTestId('annotation-sticky-body-input')).toHaveFocus();
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
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-edit'));
    view.unmount();
    mount(sticky());
    expect(screen.getByTestId('annotation-sticky-body-input')).not.toHaveFocus();
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
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));
    const box = screen.getByTestId('annotation-sticky-reply-r1-input');
    await user.clear(box);
    await user.type(box, 'one, reworded');
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-save'));
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
    await user.click(screen.getByTestId('annotation-sticky-body-menu'));
    await user.click(screen.getByTestId('annotation-sticky-body-delete'));
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
      screen.getByTestId('annotation-sticky-reply-input'),
      'not sent yet',
    );
    view.unmount();
    mount(sticky());
    expect(screen.getByTestId('annotation-sticky-reply-input')).toHaveValue(
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
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-menu'));
    await user.click(screen.getByTestId('annotation-sticky-reply-r1-edit'));
    scrollsInsideOurs(
      'annotation-sticky-replies',
      '[data-testid="annotation-sticky-reply-r1-input"]',
      NOTE_REGION_MAX_HEIGHT,
    );
    expect(
      screen.getByTestId('annotation-sticky-reply-r1-input').style.height,
    ).not.toBe('');
  });
});
