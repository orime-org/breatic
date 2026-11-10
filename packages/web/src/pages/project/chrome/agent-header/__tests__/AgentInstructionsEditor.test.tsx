// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1400 — the full-screen editor for a Project's instructions, opened from
 * the Agent header.
 *
 * Opening reads the instructions again and shows a skeleton until that read
 * is back; the draft is taken from that read once, and nothing the cache does
 * afterwards changes it. Cancel and Esc close without saving. A save waits
 * with the input and Cancel switched off; it closes and says so on success
 * and writes the answer into the cache the header's dot reads, keeps the
 * draft on failure, and still writes the cache when it settles after the
 * editor is gone. A read that comes back after the user already closed the
 * editor opens nothing and says nothing.
 *
 * The editor is driven through its one entry, the header button, so these
 * tests run the real wiring between the two.
 */

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/lib/use-autosize-textarea', async (importOriginal) => {
  const real = await importOriginal<typeof import('@web/lib/use-autosize-textarea')>();
  return { ...real, useAutosizeTextarea: vi.fn(real.useAutosizeTextarea) };
});

import { getLocale, t, type AgentInstructionsView } from '@breatic/shared';
import en from '@locales/en.json';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { agentInstructionsKey } from '@web/data/api/agent-instructions';
import { apiGet, apiPut } from '@web/data/api/request';
import { toast } from '@web/lib/toast';
import { useAutosizeTextarea } from '@web/lib/use-autosize-textarea';
import { AgentInstructionsButton } from '@web/pages/project/chrome/agent-header/AgentInstructionsButton';
import { LOCALE_CATALOGS } from '@web/test-utils/locale-catalogs';

const PROJECT = 'p-1';
const MAX = 10_000;

const EMPTY: AgentInstructionsView = { text: '', updatedBy: null, updatedAt: null };
const WRITTEN: AgentInstructionsView = {
  text: 'Answer in English.',
  updatedBy: 'Mei Tan',
  updatedAt: '2026-11-08T08:02:00.000Z',
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * A promise the test settles by hand.
 * @returns The promise and its two settlers.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockGet = vi.mocked(apiGet);
const mockPut = vi.mocked(apiPut);

/** Every GET the code under test sent, in order, each waiting for the test. */
let reads: Deferred<AgentInstructionsView>[] = [];
/** Every PUT the code under test sent, in order, each waiting for the test. */
let saves: Deferred<AgentInstructionsView>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  reads = [];
  saves = [];
  mockGet.mockImplementation(() => {
    const d = deferred<AgentInstructionsView>();
    reads.push(d);
    return d.promise;
  });
  mockPut.mockImplementation(() => {
    const d = deferred<AgentInstructionsView>();
    saves.push(d);
    return d.promise;
  });
});

/**
 * Settle one read and let React take in the answer.
 * @param index - Which read, counted from the first one sent.
 * @param view - What the server answered.
 */
async function answerRead(index: number, view: AgentInstructionsView): Promise<void> {
  await waitFor(() => expect(reads.length).toBeGreaterThan(index));
  await act(async () => {
    reads[index]!.resolve(view);
    await reads[index]!.promise;
  });
}

/**
 * Fail one read and let React take in the failure.
 * @param index - Which read, counted from the first one sent.
 */
async function failRead(index: number): Promise<void> {
  await waitFor(() => expect(reads.length).toBeGreaterThan(index));
  await act(async () => {
    reads[index]!.reject(new Error('offline'));
    await reads[index]!.promise.catch(() => undefined);
  });
}

/**
 * Settle one save and let React take in the answer.
 * @param index - Which save, counted from the first one sent.
 * @param view - What the server answered.
 */
async function answerSave(index: number, view: AgentInstructionsView): Promise<void> {
  await waitFor(() => expect(saves.length).toBeGreaterThan(index));
  await act(async () => {
    saves[index]!.resolve(view);
    await saves[index]!.promise;
  });
}

/**
 * Fail one save and let React take in the failure.
 * @param index - Which save, counted from the first one sent.
 */
async function failSave(index: number): Promise<void> {
  await waitFor(() => expect(saves.length).toBeGreaterThan(index));
  await act(async () => {
    saves[index]!.reject(new Error('rate limited'));
    await saves[index]!.promise.catch(() => undefined);
  });
}

interface Mounted {
  client: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
  /** Take the whole entry off the page, as leaving the Project page does. */
  leave: () => void;
}

/**
 * Put the header entry on the page with its mount read answered.
 * @param stored - What the server holds when the panel mounts.
 * @returns The query client, a user and a way to leave the page.
 */
async function mount(stored: AgentInstructionsView = EMPTY): Promise<Mounted> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (withEntry: boolean): React.ReactElement => (
    <QueryClientProvider client={client}>
      <TooltipProvider>{withEntry ? <AgentInstructionsButton projectId={PROJECT} /> : <div />}</TooltipProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(true));
  await answerRead(0, stored);
  return {
    client,
    user: userEvent.setup(),
    leave: () => rerender(tree(false)),
  };
}

/**
 * Press the entry and answer the read this opening sends.
 * @param m - The mounted entry.
 * @param stored - What the server holds now.
 * @returns The textarea of the editor.
 */
async function open(m: Mounted, stored: AgentInstructionsView): Promise<HTMLTextAreaElement> {
  const before = reads.length;
  await m.user.click(screen.getByTestId('agent-instructions-open'));
  await answerRead(before, stored);
  return (await screen.findByTestId('agent-instructions-input')) as HTMLTextAreaElement;
}

/**
 * The counter's text with digit grouping and spacing taken out, so `10,000 /
 * 10,000` and `10000 / 10000` read the same.
 * @returns The plain counter text.
 */
function counterText(): string {
  return (screen.getByTestId('agent-instructions-count').textContent ?? '').replace(/[\s,\u00a0\u202f]/g, '');
}

/**
 * The longest fixed run of words in the English last-edited line, the part
 * that is there whatever name and time fill it.
 * @returns That run of words.
 */
function lastEditedWords(): string {
  const template = (en as { chat?: { instructions?: { lastEdited?: unknown } } }).chat?.instructions?.lastEdited;
  expect(typeof template).toBe('string');
  const pieces = (template as string).split(/\{[^{}]*\}/).map((piece) => piece.trim());
  return pieces.reduce((a, b) => (b.length > a.length ? b : a), '');
}

describe('opening the Project instructions editor (#1400)', () => {
  it('reads again on opening and shows the skeleton until that read is back', async () => {
    const m = await mount(WRITTEN);
    await m.user.click(screen.getByTestId('agent-instructions-open'));

    await waitFor(() => expect(reads).toHaveLength(2));
    expect(screen.getByTestId('agent-instructions-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instructions-input')).toBeNull();

    await answerRead(1, { ...WRITTEN, text: 'Use only blue and white.' });

    const input = (await screen.findByTestId('agent-instructions-input')) as HTMLTextAreaElement;
    expect(input.value).toBe('Use only blue and white.');
    expect(screen.queryByTestId('agent-instructions-skeleton')).toBeNull();
  });

  it('shows no character count until the read is back, then the count of the loaded text', async () => {
    const m = await mount(WRITTEN);
    await m.user.click(screen.getByTestId('agent-instructions-open'));

    await waitFor(() => expect(reads).toHaveLength(2));
    expect(screen.getByTestId('agent-instructions-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instructions-count')).toBeNull();

    await answerRead(1, WRITTEN);

    await screen.findByTestId('agent-instructions-input');
    expect(counterText()).toContain(`${WRITTEN.text.length}/${MAX}`);
  });

  it('opens empty when nothing has been written', async () => {
    const m = await mount(EMPTY);
    const input = await open(m, EMPTY);
    expect(input.value).toBe('');
  });

  it('keeps the draft when the cache changes after the read came back', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.type(input, ' Always.');

    act(() => {
      m.client.setQueryData(agentInstructionsKey(PROJECT), { ...WRITTEN, text: 'Someone else wrote this.' });
    });

    expect(input.value).toBe('Answer in English. Always.');
  });

  it('does not open, and says so, when the read fails', async () => {
    const m = await mount(WRITTEN);
    await m.user.click(screen.getByTestId('agent-instructions-open'));
    await failRead(1);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId('agent-instructions-input')).toBeNull();
    expect(screen.queryByTestId('agent-instructions-skeleton')).toBeNull();
    expect(screen.queryByTestId('agent-instructions-editor')).toBeNull();
  });

  it('keeps the header dot when the read on opening fails', async () => {
    const m = await mount(WRITTEN);
    expect(await screen.findByTestId('agent-instructions-dot')).toBeInTheDocument();
    await m.user.click(screen.getByTestId('agent-instructions-open'));
    await failRead(1);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByTestId('agent-instructions-dot')).toBeInTheDocument();
  });

  it('opens nothing and says nothing when the read comes back after the user closed it', async () => {
    const m = await mount(EMPTY);
    await m.user.click(screen.getByTestId('agent-instructions-open'));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(screen.getByTestId('agent-instructions-skeleton')).toBeInTheDocument();

    await m.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('agent-instructions-skeleton')).toBeNull());

    await answerRead(1, WRITTEN);

    expect(screen.queryByTestId('agent-instructions-editor')).toBeNull();
    expect(screen.queryByTestId('agent-instructions-input')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // The read still counts: the header learns the Project has instructions.
    expect(await screen.findByTestId('agent-instructions-dot')).toBeInTheDocument();
  });

  it('says nothing when a read that fails comes back after the user closed it', async () => {
    const m = await mount(EMPTY);
    await m.user.click(screen.getByTestId('agent-instructions-open'));
    await waitFor(() => expect(reads).toHaveLength(2));
    await m.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('agent-instructions-skeleton')).toBeNull());

    await failRead(1);

    expect(screen.queryByTestId('agent-instructions-editor')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('takes the draft from the read of the newest opening, not an earlier one', async () => {
    const m = await mount(EMPTY);
    await m.user.click(screen.getByTestId('agent-instructions-open'));
    await waitFor(() => expect(reads).toHaveLength(2));
    await m.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('agent-instructions-skeleton')).toBeNull());

    await m.user.click(screen.getByTestId('agent-instructions-open'));
    // A second read, or the first one still in flight: either way the draft
    // is what the last read sent answers.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await answerRead(reads.length - 1, { ...WRITTEN, text: 'The newest text.' });
    const input = (await screen.findByTestId('agent-instructions-input')) as HTMLTextAreaElement;
    expect(input.value).toBe('The newest text.');

    // The abandoned read lands late; the editor of this opening keeps its draft.
    await act(async () => {
      reads[1]!.resolve({ ...WRITTEN, text: 'An old text.' });
      await reads[1]!.promise;
    });
    expect(input.value).toBe('The newest text.');
  });
});

describe('the editor body (#1400)', () => {
  it('fills the screen, with no backdrop around it to press', async () => {
    const m = await mount(WRITTEN);
    await open(m, WRITTEN);
    const editor = screen.getByTestId('agent-instructions-editor');
    expect(editor.className).toContain('inset-0');
    expect(document.querySelector('.bg-overlay')).toBeNull();
  });

  it('does not scroll itself: the textarea hides overflow inside a vertical ScrollArea', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);

    expect(input.className).toContain('overflow-hidden');
    expect(input.className).toContain('resize-none');
    // The dialog overlay is a ScrollArea of its own, so the scroller that
    // counts is the nearest one, and it has to sit inside the editor.
    const editor = screen.getByTestId('agent-instructions-editor');
    const viewport = input.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    const scroller = input.closest<HTMLElement>('[data-scrollbars]');
    expect(viewport).not.toBeNull();
    expect(scroller).not.toBeNull();
    expect(editor).toContainElement(viewport);
    expect(editor).toContainElement(scroller);
    expect(scroller!.getAttribute('data-scrollbars')).toBe('vertical');
  });

  it('sizes the textarea to its text with useAutosizeTextarea', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.type(input, '!');

    const sized = vi.mocked(useAutosizeTextarea).mock.calls.filter(([box]) => box.current === input);
    expect(sized.length).toBeGreaterThan(0);
    expect(sized.at(-1)![1]).toBe('Answer in English.!');
  });

  it('caps the input at 10000 characters', async () => {
    const m = await mount(EMPTY);
    const input = await open(m, EMPTY);
    expect(input.getAttribute('maxlength')).toBe(String(MAX));
  });

  it('counts what is written against 10000', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    expect(counterText()).toContain(`${WRITTEN.text.length}/${MAX}`);
    await m.user.type(input, 'ab');
    expect(counterText()).toContain(`${WRITTEN.text.length + 2}/${MAX}`);
  });

  it('says the limit is reached at exactly 10000, and not one short of it', async () => {
    const atLimit = t('chat.instructions.atLimit', { max: MAX });
    expect(atLimit).not.toBe('chat.instructions.atLimit');

    const m = await mount(EMPTY);
    const input = await open(m, { ...EMPTY, text: 'x'.repeat(MAX - 1) });
    expect(counterText()).toContain(`${MAX - 1}/${MAX}`);
    expect(screen.getByTestId('agent-instructions-count')).not.toHaveTextContent(atLimit);

    await m.user.type(input, 'yz');
    expect(input.value).toHaveLength(MAX);
    expect(counterText()).toContain(`${MAX}/${MAX}`);
    expect(screen.getByTestId('agent-instructions-count')).toHaveTextContent(atLimit);
  });

  it('opens at the limit when the stored text is exactly 10000 long', async () => {
    const m = await mount(EMPTY);
    await open(m, { ...WRITTEN, text: 'x'.repeat(MAX) });
    expect(counterText()).toContain(`${MAX}/${MAX}`);
    expect(screen.getByTestId('agent-instructions-count')).toHaveTextContent(t('chat.instructions.atLimit', { max: MAX }));
  });

  it('shows who edited last when someone has', async () => {
    const m = await mount(WRITTEN);
    await open(m, WRITTEN);
    const editor = screen.getByTestId('agent-instructions-editor');
    const words = lastEditedWords();
    expect(words.length).toBeGreaterThan(0);
    expect(editor).toHaveTextContent(words);
    expect(within(editor).getByText(/Mei Tan/)).toHaveTextContent(words);
  });

  it('writes the last-edited time as a short date and time, without seconds', async () => {
    const m = await mount(WRITTEN);
    await open(m, WRITTEN);
    const footer = within(screen.getByTestId('agent-instructions-editor')).getByText(/Mei Tan/);
    const at = new Date(WRITTEN.updatedAt!);
    const short = at.toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });
    const withSeconds = at.toLocaleString(getLocale());
    expect(short).not.toBe(withSeconds);

    expect(footer.textContent).toContain(short);
    expect(footer.textContent).not.toContain(withSeconds);
  });

  it('shows no last-edited line when nobody has written yet', async () => {
    const m = await mount(EMPTY);
    await open(m, EMPTY);
    expect(screen.getByTestId('agent-instructions-editor')).not.toHaveTextContent(lastEditedWords());
  });
});

describe('cancelling (#1400)', () => {
  it('closes on Cancel and drops the draft', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.type(input, ' Draft.');
    await m.user.click(screen.getByTestId('agent-instructions-cancel'));

    await waitFor(() => expect(screen.queryByTestId('agent-instructions-editor')).toBeNull());
    expect(mockPut).not.toHaveBeenCalled();

    const again = await open(m, WRITTEN);
    expect(again.value).toBe('Answer in English.');
  });

  it('closes on Esc and drops the draft', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.type(input, ' Draft.');
    await m.user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('agent-instructions-editor')).toBeNull());
    expect(mockPut).not.toHaveBeenCalled();
  });
});

/**
 * Press Escape inside the textarea. Radix listens on the document in the
 * capture phase, so a keydown dispatched on the textarea reaches it.
 * @param input - The textarea.
 * @param init - The input method fields of the keydown.
 * @param init.keyCode - The legacy key code the browser reports.
 * @param init.isComposing - Whether a composition is still running.
 */
function pressEscape(
  input: HTMLTextAreaElement,
  init: { keyCode: number; isComposing: boolean },
): void {
  const event = createEvent.keyDown(input, { key: 'Escape', code: 'Escape', ...init });
  // The keydown really carries the fields the guard reads.
  expect(event).toMatchObject(init);
  act(() => {
    fireEvent(input, event);
  });
}

describe('an Escape that belongs to the input method (#1400)', () => {
  it('stays open with the draft for an Escape sent while composing', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.type(input, ' Draft.');

    pressEscape(input, { keyCode: 27, isComposing: true });

    expect(screen.getByTestId('agent-instructions-editor')).toBeInTheDocument();
    expect(input.value).toBe('Answer in English. Draft.');
  });

  it('stays open with the draft for an Escape reported as key code 229', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.type(input, ' Draft.');

    pressEscape(input, { keyCode: 229, isComposing: false });

    expect(screen.getByTestId('agent-instructions-editor')).toBeInTheDocument();
    expect(input.value).toBe('Answer in English. Draft.');
  });

  it('stays open with the draft for the Escape that arrives right after the composition ended', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.type(input, ' Draft.');

    act(() => {
      fireEvent.compositionStart(input);
      fireEvent.compositionEnd(input);
    });
    // Same task as the composition end: the mark has not been released yet.
    pressEscape(input, { keyCode: 27, isComposing: false });

    expect(screen.getByTestId('agent-instructions-editor')).toBeInTheDocument();
    expect(input.value).toBe('Answer in English. Draft.');
  });

  it('closes on an Escape pressed once the composition end has been released', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);

    act(() => {
      fireEvent.compositionStart(input);
      fireEvent.compositionEnd(input);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    pressEscape(input, { keyCode: 27, isComposing: false });

    await waitFor(() => expect(screen.queryByTestId('agent-instructions-editor')).toBeNull());
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('still closes on a plain Escape with no composition', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);

    pressEscape(input, { keyCode: 27, isComposing: false });

    await waitFor(() => expect(screen.queryByTestId('agent-instructions-editor')).toBeNull());
    expect(mockPut).not.toHaveBeenCalled();
  });
});

describe('saving (#1400)', () => {
  it('sends the draft, waits on the button, and switches the input and Cancel off', async () => {
    const m = await mount(EMPTY);
    const input = await open(m, EMPTY);
    await m.user.type(input, 'Answer in English.');
    await m.user.click(screen.getByTestId('agent-instructions-save'));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(mockPut.mock.calls[0]!.slice(0, 2)).toEqual([
      '/chat/instructions',
      { project_id: PROJECT, text: 'Answer in English.' },
    ]);
    expect(screen.getByTestId('agent-instructions-save')).toHaveAttribute('aria-busy', 'true');
    expect(input).toBeDisabled();

    await m.user.click(screen.getByTestId('agent-instructions-cancel'));
    await m.user.keyboard('{Escape}');
    expect(screen.getByTestId('agent-instructions-editor')).toBeInTheDocument();
    expect(input.value).toBe('Answer in English.');

    await m.user.click(screen.getByTestId('agent-instructions-save'));
    expect(saves).toHaveLength(1);
  });

  it('closes, says saved and lights the dot on success', async () => {
    const m = await mount(EMPTY);
    expect(screen.queryByTestId('agent-instructions-dot')).toBeNull();
    const input = await open(m, EMPTY);
    await m.user.type(input, 'Answer in English.');
    await m.user.click(screen.getByTestId('agent-instructions-save'));
    await answerSave(0, WRITTEN);

    await waitFor(() => expect(screen.queryByTestId('agent-instructions-editor')).toBeNull());
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(t('chat.instructions.saved'));
    expect(t('chat.instructions.saved')).not.toBe('chat.instructions.saved');
    expect(m.client.getQueryData(agentInstructionsKey(PROJECT))).toEqual(WRITTEN);
    expect(await screen.findByTestId('agent-instructions-dot')).toBeInTheDocument();
  });

  it('says cleared and drops the dot when the saved text is empty', async () => {
    const m = await mount(WRITTEN);
    expect(await screen.findByTestId('agent-instructions-dot')).toBeInTheDocument();
    const input = await open(m, WRITTEN);
    await m.user.clear(input);
    await m.user.click(screen.getByTestId('agent-instructions-save'));
    await answerSave(0, EMPTY);

    await waitFor(() => expect(screen.queryByTestId('agent-instructions-editor')).toBeNull());
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(t('chat.instructions.cleared'));
    expect(t('chat.instructions.cleared')).not.toBe('chat.instructions.cleared');
    expect(screen.queryByTestId('agent-instructions-dot')).toBeNull();
  });

  it('sends whitespace as written and says cleared, since it holds no words', async () => {
    const m = await mount(WRITTEN);
    const input = await open(m, WRITTEN);
    await m.user.clear(input);
    await m.user.type(input, '   ');
    await m.user.click(screen.getByTestId('agent-instructions-save'));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(mockPut.mock.calls[0]![1]).toEqual({ project_id: PROJECT, text: '   ' });
    await answerSave(0, EMPTY);

    await waitFor(() => expect(screen.queryByTestId('agent-instructions-editor')).toBeNull());
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(t('chat.instructions.cleared'));
  });

  it('stays open with the draft, and says so, when the save fails', async () => {
    const m = await mount(EMPTY);
    const input = await open(m, EMPTY);
    await m.user.type(input, 'Answer in English.');
    await m.user.click(screen.getByTestId('agent-instructions-save'));
    await failSave(0);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByTestId('agent-instructions-editor')).toBeInTheDocument();
    expect(input.value).toBe('Answer in English.');
    expect(input).not.toBeDisabled();
    expect(screen.getByTestId('agent-instructions-save')).not.toHaveAttribute('aria-busy', 'true');
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-instructions-dot')).toBeNull();
  });

  it('lets the saved answer stand over a read that was in flight when the save went out', async () => {
    const m = await mount(EMPTY);
    const input = await open(m, EMPTY);
    // Something asks for the instructions again while the user is writing.
    act(() => {
      void m.client.invalidateQueries({ queryKey: agentInstructionsKey(PROJECT) });
    });
    await waitFor(() => expect(reads).toHaveLength(3));

    await m.user.type(input, 'Answer in English.');
    await m.user.click(screen.getByTestId('agent-instructions-save'));
    await answerSave(0, WRITTEN);
    await act(async () => {
      reads[2]!.resolve(EMPTY);
      await reads[2]!.promise;
    });

    expect(m.client.getQueryData(agentInstructionsKey(PROJECT))).toEqual(WRITTEN);
    expect(screen.getByTestId('agent-instructions-dot')).toBeInTheDocument();
  });

  it('still writes the cache when the save settles after the user left the page', async () => {
    const m = await mount(EMPTY);
    const input = await open(m, EMPTY);
    await m.user.type(input, 'Answer in English.');
    await m.user.click(screen.getByTestId('agent-instructions-save'));
    await waitFor(() => expect(saves).toHaveLength(1));

    m.leave();
    expect(screen.queryByTestId('agent-instructions-editor')).toBeNull();
    await answerSave(0, WRITTEN);

    expect(m.client.getQueryData(agentInstructionsKey(PROJECT))).toEqual(WRITTEN);
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(t('chat.instructions.saved'));
  });
});

describe('the copy (#1400)', () => {
  it('writes the limit through {max, number} in every locale, the way the counter beside it formats it', () => {
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      const line = (catalog as { chat?: { instructions?: { atLimit?: unknown } } }).chat?.instructions?.atLimit;
      expect(line, `${tag} chat.instructions.atLimit`).toContain('{max, number}');
    }
  });

  it.each(['open', 'saved', 'cleared', 'atLimit', 'lastEdited'])(
    'every locale has chat.instructions.%s',
    (key) => {
      for (const [tag, catalog] of LOCALE_CATALOGS) {
        const chat = (catalog as { chat?: { instructions?: Record<string, unknown> } }).chat;
        expect(typeof chat?.instructions?.[key], `${tag} chat.instructions.${key}`).toBe('string');
      }
    },
  );
});
