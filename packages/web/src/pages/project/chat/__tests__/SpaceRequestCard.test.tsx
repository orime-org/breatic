// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The card an Agent's request to look at Spaces is drawn as (inner#1552,
 * design 4.4, DD 5.2, demo `2026-11-01-1552-space-request-card.html`).
 *
 * Waiting, it lists each Space asked for with the part asked for and the
 * reason, and offers 「拒绝查看」 on the left and 「同意查看」 on the right.
 * Allowing reads the Spaces, over a socket at the shared socket's address,
 * then sends them; while either runs the card has nothing to press. Settled,
 * it is one line, and a shared card lists only what could not be read.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@breatic/shared';

import { CollabSocketProvider } from '@web/data/yjs/collab-socket';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import { SpaceRequestCard } from '@web/pages/project/chat/SpaceRequestCard';
import { SpaceRequestAnswerContext } from '@web/pages/project/chat/space-request-answer';
import { TurnEnding } from '@web/pages/project/chat/TurnEnding';
import type { ChatMessage, ChatSpaceRequest } from '@web/pages/project/chat/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

type Answering = React.ContextType<typeof SpaceRequestAnswerContext> & object;
type ReadResult = Awaited<ReturnType<Answering['read']>>;

const SPACES: ProjectSpace[] = [
  { id: 'd1', name: 'Script v3', type: 'document', createdAt: 1 },
  { id: 'c1', name: 'Cast board', type: 'canvas', createdAt: 2 },
  { id: 't1', name: 'Intro', type: 'timeline', createdAt: 3 },
];

const REQUEST: ChatSpaceRequest = {
  toolCallId: 'req-1',
  reason: 'You asked about the second half of the script and three characters.',
  spaces: [{ id: 'd1', blocks: { from: 41 } }, { id: 'c1', node_ids: ['n1', 'n2', 'n3'] }, { id: 't1' }],
  state: 'awaiting',
};

const READ: ReadResult = [
  { id: 'd1', name: 'Script v3', kind: 'document', state: 'read', part: { blocks: { from: 41 } }, content: '<!-- b:41 -->\nx', total_chars: 15, blocks_total: 41 },
] as ReadResult;

const SOCKET_URL = 'wss://collab.test/ws';

afterEach(cleanup);

/**
 * A promise and the hand that settles it.
 * @returns Both.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * How the panel would answer, with spies.
 * @param overrides - What this case changes.
 * @returns The value the card is given.
 */
function answering(overrides: Partial<Answering> = {}): Answering {
  return {
    spaces: SPACES,
    busy: false,
    read: vi.fn(async () => READ),
    answer: vi.fn(async () => undefined),
    ...overrides,
  } as Answering;
}

/**
 * Draw a card inside the panel's context and the collab socket's.
 * @param request - The request.
 * @param value - How the panel answers.
 * @returns The render result.
 */
function draw(request: ChatSpaceRequest, value: Answering = answering()): ReturnType<typeof render> {
  return render(
    <CollabSocketProvider userId='u1' url={SOCKET_URL}>
      <SpaceRequestAnswerContext.Provider value={value}>
        <SpaceRequestCard request={request} />
      </SpaceRequestAnswerContext.Provider>
    </CollabSocketProvider>,
  );
}

/**
 * The rows the card lists.
 * @returns Them, in order.
 */
function rows(): HTMLElement[] {
  return screen.queryAllByTestId('space-request-row');
}

describe('a card waiting for the user', () => {
  it('sits in the same frame as the questionnaire card', () => {
    draw(REQUEST);

    expect(screen.getByTestId('space-request-card')).toHaveClass('rounded-overlay', 'border', 'border-border', 'bg-popover', 'px-3', 'py-2.5');
  });

  it('says what the Agent wants and why', () => {
    draw(REQUEST);
    const card = screen.getByTestId('space-request-card');

    expect(card).toHaveTextContent(t('chat.spaceRequest.title'));
    expect(card).toHaveTextContent(REQUEST.reason);
  });

  it('lists each Space asked for by its name and kind from the project list', () => {
    draw(REQUEST);

    expect(rows()).toHaveLength(3);
    expect(rows().map((r) => r.dataset.kind)).toEqual(['document', 'canvas', 'timeline']);
    expect(rows()[0]).toHaveTextContent('Script v3');
    expect(rows()[1]).toHaveTextContent('Cast board');
    expect(rows()[2]).toHaveTextContent('Intro');
  });

  it('names the part asked for: a range of blocks, a count of nodes, nothing for a whole Space', () => {
    draw({ ...REQUEST, spaces: [{ id: 'd1', blocks: { from: 3, to: 7 } }, { id: 'c1', node_ids: ['n1', 'n2', 'n3'] }, { id: 't1' }] });

    expect(within(rows()[0]!).getByTestId('space-request-part')).toHaveTextContent('3');
    expect(within(rows()[0]!).getByTestId('space-request-part')).toHaveTextContent('7');
    expect(within(rows()[1]!).getByTestId('space-request-part')).toHaveTextContent('3');
    expect(within(rows()[2]!).queryByTestId('space-request-part')).toBeNull();
  });

  it('names a range that runs to the end by where it starts', () => {
    draw(REQUEST);

    expect(within(rows()[0]!).getByTestId('space-request-part')).toHaveTextContent('41');
  });

  it('shows a Space the project no longer lists as deleted', () => {
    draw({ ...REQUEST, spaces: [{ id: 'gone-1' }] });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent(t('chat.spaceRequest.state.gone'));
  });

  it('puts 「拒绝查看」 on the left and 「同意查看」 on the right', () => {
    draw(REQUEST);
    const buttons = within(screen.getByTestId('space-request-card')).getAllByRole('button');

    expect(buttons.map((b) => b.dataset.testid)).toEqual(['space-request-decline', 'space-request-allow']);
    expect(buttons[0]).toHaveTextContent(t('chat.spaceRequest.decline'));
    expect(buttons[1]).toHaveTextContent(t('chat.spaceRequest.allow'));
  });

  it('has no accessibility violations', async () => {
    draw(REQUEST);

    await expectNoA11yViolations(document.body);
  });
});

describe('allowing', () => {
  it('reads the Spaces at the shared socket\'s address, then sends what it read as shared', async () => {
    const user = userEvent.setup();
    const value = answering();
    draw(REQUEST, value);

    await user.click(screen.getByTestId('space-request-allow'));

    expect(value.read).toHaveBeenCalledWith(REQUEST, SOCKET_URL, expect.any(AbortSignal));
    expect(value.answer).toHaveBeenCalledWith({ toolCallId: 'req-1', decision: 'shared', spaces: READ });
  });

  it('shows 「同意查看」 waiting and 「拒绝查看」 off while it reads, and nothing is sent until the read is done', async () => {
    const user = userEvent.setup();
    const reading = deferred<ReadResult>();
    const value = answering({ read: vi.fn(() => reading.promise) });
    draw(REQUEST, value);

    await user.click(screen.getByTestId('space-request-allow'));

    expect(screen.getByTestId('space-request-allow')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('space-request-decline')).toBeDisabled();
    expect(value.answer).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('space-request-allow'));
    await user.click(screen.getByTestId('space-request-decline'));
    expect(value.read).toHaveBeenCalledTimes(1);
    expect(value.answer).not.toHaveBeenCalled();

    await act(async () => reading.resolve(READ));
    expect(value.answer).toHaveBeenCalledTimes(1);
  });

  it('keeps both buttons unpressable while the answer is in flight', async () => {
    const user = userEvent.setup();
    const sending = deferred<undefined>();
    const value = answering({ answer: vi.fn(() => sending.promise) });
    draw(REQUEST, value);

    await user.click(screen.getByTestId('space-request-allow'));

    expect(value.answer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('space-request-allow')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('space-request-decline')).toBeDisabled();
    await user.click(screen.getByTestId('space-request-decline'));
    expect(value.answer).toHaveBeenCalledTimes(1);
    await act(async () => sending.resolve(undefined));
  });

  it('can be pressed again when the send is over and the card is still waiting', async () => {
    const user = userEvent.setup();
    draw(REQUEST);

    await user.click(screen.getByTestId('space-request-allow'));

    expect(screen.getByTestId('space-request-allow')).not.toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('space-request-decline')).toBeEnabled();
  });

  it('drops the read when the card stops waiting while it reads, and sends nothing', async () => {
    const user = userEvent.setup();
    const reading = deferred<ReadResult>();
    const read = vi.fn((_request: ChatSpaceRequest, _url: string, _signal: AbortSignal) => reading.promise);
    const value = answering({ read: read as unknown as Answering['read'] });
    const { rerender } = draw(REQUEST, value);
    await user.click(screen.getByTestId('space-request-allow'));
    const signal = read.mock.calls[0]![2];

    rerender(
      <CollabSocketProvider userId='u1' url={SOCKET_URL}>
        <SpaceRequestAnswerContext.Provider value={value}>
          <SpaceRequestCard request={{ ...REQUEST, state: 'replied' }} />
        </SpaceRequestAnswerContext.Provider>
      </CollabSocketProvider>,
    );
    await act(async () => reading.resolve(READ));

    expect(signal.aborted).toBe(true);
    expect(value.answer).not.toHaveBeenCalled();
    expect(screen.getByTestId('space-request-card')).toHaveTextContent(t('chat.questionnaire.replied'));
  });

  it('drops the read when the card goes away while it reads', async () => {
    const user = userEvent.setup();
    const read = vi.fn((_request: ChatSpaceRequest, _url: string, _signal: AbortSignal) => new Promise<ReadResult>(() => undefined));
    const { unmount } = draw(REQUEST, answering({ read: read as unknown as Answering['read'] }));
    await user.click(screen.getByTestId('space-request-allow'));
    const signal = read.mock.calls[0]![2];

    unmount();

    expect(signal.aborted).toBe(true);
  });
});

describe('declining', () => {
  it('sends declined without reading anything', async () => {
    const user = userEvent.setup();
    const value = answering();
    draw(REQUEST, value);

    await user.click(screen.getByTestId('space-request-decline'));

    expect(value.read).not.toHaveBeenCalled();
    expect(value.answer).toHaveBeenCalledWith({ toolCallId: 'req-1', decision: 'declined' });
  });

  it('leaves nothing to press while the answer is in flight', async () => {
    const user = userEvent.setup();
    const sending = deferred<undefined>();
    const value = answering({ answer: vi.fn(() => sending.promise) });
    draw(REQUEST, value);

    await user.click(screen.getByTestId('space-request-decline'));

    expect(screen.getByTestId('space-request-allow')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('space-request-decline')).toBeDisabled();
    await user.click(screen.getByTestId('space-request-allow'));
    expect(value.read).not.toHaveBeenCalled();
    await act(async () => sending.resolve(undefined));
  });
});

describe('a turn already running in the conversation', () => {
  it('shows 「同意查看」 waiting and takes no press on either button', async () => {
    const user = userEvent.setup();
    const value = answering({ busy: true });
    draw(REQUEST, value);

    expect(screen.getByTestId('space-request-allow')).toHaveAttribute('aria-busy', 'true');
    await user.click(screen.getByTestId('space-request-allow'));
    await user.click(screen.getByTestId('space-request-decline'));

    expect(value.read).not.toHaveBeenCalled();
    expect(value.answer).not.toHaveBeenCalled();
  });
});

describe('a settled card', () => {
  it('lists what was shared, marking only the Spaces that could not be read', () => {
    draw({
      ...REQUEST,
      spaces: [{ id: 'd1' }, { id: 'c1' }, { id: 't1' }, { id: 'x1' }, { id: 'x2' }],
      state: 'shared',
      results: [
        { id: 'd1', name: 'Script as shared', kind: 'document', state: 'read' },
        { id: 'c1', name: 'Cast board', kind: 'canvas', state: 'timed_out' },
        { id: 't1', name: 'Intro', kind: 'timeline', state: 'unreadable' },
        { id: 'x1', name: 'Moodboard', kind: 'canvas', state: 'failed' },
        { id: 'x2', state: 'gone' },
      ],
    });
    const card = screen.getByTestId('space-request-card');

    expect(card).toHaveTextContent(t('chat.spaceRequest.shared'));
    expect(rows()).toHaveLength(5);
    expect(rows()[0]).toHaveTextContent('Script as shared');
    expect(within(rows()[0]!).queryByTestId('space-request-state')).toBeNull();
    expect(within(rows()[1]!).getByTestId('space-request-state')).toHaveTextContent(t('chat.spaceRequest.state.timedOut'));
    expect(within(rows()[2]!).getByTestId('space-request-state')).toHaveTextContent(t('chat.spaceRequest.state.unreadable'));
    expect(within(rows()[3]!).getByTestId('space-request-state')).toHaveTextContent(t('chat.spaceRequest.state.failed'));
    expect(rows()[4]).toHaveTextContent(t('chat.spaceRequest.state.gone'));
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  it('starts the mark of a deleted Space where its name would be, and keeps the others at the end of the row', () => {
    draw({
      ...REQUEST,
      spaces: [{ id: 'c1' }, { id: 'x2' }],
      state: 'shared',
      results: [
        { id: 'c1', name: 'Cast board', kind: 'canvas', state: 'timed_out' },
        { id: 'x2', state: 'gone' },
      ],
    });

    expect(within(rows()[0]!).getByTestId('space-request-state')).toHaveClass('ml-auto');
    expect(within(rows()[1]!).getByTestId('space-request-state')).not.toHaveClass('ml-auto');
  });

  it('heads a waiting card like the proposal cards and a settled one in muted text', () => {
    const { unmount } = draw(REQUEST);
    expect(screen.getByTestId('space-request-heading')).toHaveClass('font-semibold', 'text-foreground');
    unmount();

    draw({ ...REQUEST, state: 'declined' });
    const settled = screen.getByTestId('space-request-heading');
    expect(settled).toHaveClass('text-muted-foreground');
    expect(settled).not.toHaveClass('font-semibold');
    expect(settled).not.toHaveClass('font-medium');
  });

  it('shows a Space that was gone as deleted even when the summary kept its name', () => {
    draw({ ...REQUEST, spaces: [{ id: 'd1' }], state: 'shared', results: [{ id: 'd1', name: 'Script v3', kind: 'document', state: 'gone' }] });

    expect(within(rows()[0]!).getByTestId('space-request-state')).toHaveTextContent(t('chat.spaceRequest.state.gone'));
  });

  it('is one line when the user declined', () => {
    draw({ ...REQUEST, state: 'declined' });
    const card = screen.getByTestId('space-request-card');

    expect(card).toHaveTextContent(t('chat.spaceRequest.declined'));
    expect(rows()).toHaveLength(0);
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  it('is one line when the user replied in the chat', () => {
    draw({ ...REQUEST, state: 'replied' });
    const card = screen.getByTestId('space-request-card');

    expect(card).toHaveTextContent(t('chat.questionnaire.replied'));
    expect(rows()).toHaveLength(0);
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('the card in a reply', () => {
  const message: ChatMessage = { id: 'a1', role: 'assistant', content: '', spaceRequests: [REQUEST] };

  it('is drawn by the reply that carries it', () => {
    render(
      <SpaceRequestAnswerContext.Provider value={answering()}>
        <MessageBubble message={message} />
      </SpaceRequestAnswerContext.Provider>,
    );

    expect(screen.getByTestId('space-request-card')).toBeInTheDocument();
  });

  it('counts as something the turn produced, so no empty line follows it', () => {
    render(<TurnEnding message={message} />);

    expect(screen.queryByTestId('message-bubble-empty')).toBeNull();
  });
});
