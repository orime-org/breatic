// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Having more than one conversation in a project, and moving between them.
 *
 * The sibling file covers what one conversation does on its own. This one is
 * about the several: the list, switching, starting another, naming, removing,
 * and the half-typed message each of them is holding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    openChat: vi.fn(),
    streamMessage: vi.fn(),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { chatApi } from '@web/data/api/chat';
import {
  conversationRuntime,
  useConversationRuntime,
  _resetForTests,
} from '@web/stores/conversation-runtime';

const PROJECT = 'p-1';

/**
 * Answer the open call with a list and whichever one is current.
 * @param conversations - The list as the server would give it
 * @param currentId - Which of them the panel lands on
 */
function openAnswers(
  conversations: Array<{ id: string; title: string | null }>,
  currentId: string,
): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations,
    current: {
      conversation: conversations.find((c) => c.id === currentId)!,
      messages: [],
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/** The conversation the panel is showing in this project. */
function currentId(): string | undefined {
  return useConversationRuntime.getState().currentByProject[PROJECT];
}

/** The list the panel would render, in the order it would render it. */
function listedIds(): string[] {
  return (useConversationRuntime.getState().listByProject[PROJECT] ?? []).map((c) => c.id);
}

describe('the list of conversations in a project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('keeps the list that came back with the open call', async () => {
    // It arrives with the messages and was being thrown away, which is why
    // the history sheet had nothing to show even once it could be opened.
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: null }], 'c-1');

    await conversationRuntime.ensureLoaded(PROJECT);

    expect(listedIds()).toEqual(['c-1', 'c-2']);
    expect(currentId()).toBe('c-1');
  });

  it('forgets the list when the reader leaves the project', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    conversationRuntime.leaveProject(PROJECT);

    expect(listedIds()).toEqual([]);
  });
});

describe('switching to another conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('shows the one that was picked, with its own messages', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [
        {
          id: 'm-9',
          role: 'user',
          parts: [{ type: 'text', text: 'said in the other one' }],
          content: 'said in the other one',
          ts: '2026-08-15T00:00:00Z',
          turnIndex: 3,
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(currentId()).toBe('c-2');
    const held = useConversationRuntime.getState().conversations['c-2'];
    expect(held?.messages.map((m) => m.content)).toEqual(['said in the other one']);
    // Carried across, or the panel it lands in cannot know whether there is
    // anything for "load earlier" to load.
    expect(held?.hasMore).toBe(true);
  });

  it('leaves the panel where it was when the switch fails', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(currentId()).toBe('c-1');
  });

  it('does not ask again for one it is already showing', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    await conversationRuntime.switchTo(PROJECT, 'c-1');

    expect(chatApi.readConversation).not.toHaveBeenCalled();
  });
});

describe('starting another conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('switches to the new one only once the server has made it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);

    await conversationRuntime.startNew(PROJECT);

    expect(currentId()).toBe('c-new');
    expect(listedIds()).toContain('c-new');
  });

  it('changes nothing when the server does not make it', async () => {
    // The panel stays on the conversation the reader was in, with whatever
    // they had typed still in front of them.
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a sentence');
    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.startNew(PROJECT);

    expect(currentId()).toBe('c-1');
    expect(listedIds()).toEqual(['c-1']);
    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('half a sentence');
  });

  it('puts the new one at the top, where the most recent one belongs', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);

    await conversationRuntime.startNew(PROJECT);

    expect(listedIds()).toEqual(['c-new', 'c-1']);
  });
});

describe('naming a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('shows the new name in the list', async () => {
    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.renameConversation).mockResolvedValue({
      id: 'c-1',
      title: 'Storyboard notes',
    } as unknown as Awaited<ReturnType<typeof chatApi.renameConversation>>);

    await conversationRuntime.rename(PROJECT, 'c-1', 'Storyboard notes');

    const listed = useConversationRuntime.getState().listByProject[PROJECT];
    expect(listed?.[0]?.title).toBe('Storyboard notes');
  });

  it('leaves the old name in place when the rename fails', async () => {
    openAnswers([{ id: 'c-1', title: 'the old one' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.renameConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.rename(PROJECT, 'c-1', 'never lands');

    const listed = useConversationRuntime.getState().listByProject[PROJECT];
    expect(listed?.[0]?.title).toBe('the old one');
  });

  it('takes the name the turn gives it when the first message names it', async () => {
    // The server names a conversation after its first message and says so on
    // the event that opens the turn. Without taking it here, the list goes on
    // showing the placeholder until the reader leaves and comes back.
    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    conversationRuntime.noteActivity(PROJECT, 'c-1', 'find me a reference');

    const listed = useConversationRuntime.getState().listByProject[PROJECT];
    expect(listed?.[0]?.title).toBe('find me a reference');
  });
});

describe('removing a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('takes it out of the list', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);

    await conversationRuntime.remove(PROJECT, 'c-2');

    expect(listedIds()).toEqual(['c-1']);
    expect(currentId()).toBe('c-1');
  });

  it('moves to the next one when the reader deletes the one they are in', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    await conversationRuntime.remove(PROJECT, 'c-1');

    expect(listedIds()).toEqual(['c-2']);
    expect(currentId()).toBe('c-2');
  });

  it('opens a fresh one when the last conversation is deleted', async () => {
    // Opening chat in a project with none makes one, which is the same answer
    // the reader would get by leaving and coming back.
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-fresh', title: null }],
      current: {
        conversation: { id: 'c-fresh', title: null },
        messages: [],
        hasMore: false,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

    await conversationRuntime.remove(PROJECT, 'c-1');

    expect(currentId()).toBe('c-fresh');
    expect(listedIds()).toEqual(['c-fresh']);
  });

  it('leaves the list alone when the delete fails', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.remove(PROJECT, 'c-2');

    expect(listedIds()).toEqual(['c-1', 'c-2']);
  });
});

describe('what each conversation has half-typed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('holds one draft per conversation, not one for the panel', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a thought');
    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(conversationRuntime.draftOf(PROJECT, 'c-2')).toBe('');
  });

  it('gives back what was left in a conversation on returning to it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a thought');
    await conversationRuntime.switchTo(PROJECT, 'c-2');
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-1', title: 'first' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
    await conversationRuntime.switchTo(PROJECT, 'c-1');

    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('half a thought');
  });

  it('forgets every draft in a project once the reader leaves it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a thought');

    conversationRuntime.leaveProject(PROJECT);

    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('');
  });
});

describe('what the list says about when a conversation was last used', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('moves the one just spoken in to the top, and freshens its time', () => {
    // The list is the server's answer from when the project opened, and the
    // server will not mention it again until the project is re-opened. So
    // speaking in a conversation has to be recorded here, or the row goes on
    // claiming it was last used days ago -- and `remove` reads this order to
    // decide where to land.
    const old = '2026-08-01T00:00:00Z';
    useConversationRuntime.setState({
      listByProject: {
        [PROJECT]: [
          { id: 'c-1', title: 'first', updatedAt: old },
          { id: 'c-2', title: 'second', updatedAt: old },
        ] as never,
      },
    });

    conversationRuntime.noteActivity(PROJECT, 'c-2', 'said something');

    const listed = useConversationRuntime.getState().listByProject[PROJECT]!;
    expect(listed.map((c) => c.id)).toEqual(['c-2', 'c-1']);
    expect(listed[0]!.title).toBe('said something');
    expect(listed[0]!.updatedAt).not.toBe(old);
  });
});

describe('typing before the conversation has arrived', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('keeps what was typed, and hands it to the conversation that turns up', async () => {
    // There is no conversation to keep it under for the length of one round
    // trip, and that is exactly when a reader opens a project and starts
    // typing. Dropping it made the box eat their sentence.
    conversationRuntime.setDraft(PROJECT, undefined, 'typed while loading');
    expect(conversationRuntime.draftOf(PROJECT, undefined)).toBe('typed while loading');

    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('typed while loading');
  });

  it('does not write over a sentence the conversation already had', async () => {
    conversationRuntime.setDraft(PROJECT, 'c-1', 'typed in the conversation');
    conversationRuntime.setDraft(PROJECT, undefined, 'typed while loading');

    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('typed in the conversation');
  });
});
