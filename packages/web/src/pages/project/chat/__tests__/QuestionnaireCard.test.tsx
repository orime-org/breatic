// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The questionnaire card (inner#1542).
 *
 * One to four numbered questions, each answered by clicking its options or
 * writing on its Other line, and one button that sends every answer at once.
 * A question left alone is skipped; a card with nothing answered says so on
 * the press rather than going nowhere.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getLocale, type AskUserQuestion } from '@breatic/shared';

const warning = vi.fn();
vi.mock('@web/lib/toast', () => ({ toast: { warning: (...args: unknown[]) => warning(...args), error: vi.fn() } }));

const { QuestionnaireCard } = await import('@web/pages/project/chat/QuestionnaireCard');
const { expectNoA11yViolations } = await import('@web/test-utils/a11y');

const QUESTIONS: AskUserQuestion[] = [
  { header: 'Ratio', question: 'Which ratio?', multiSelect: false, options: [{ label: '16:9', description: 'Wide' }, { label: '9:16' }] },
  { header: 'Elements', question: 'What should appear?', multiSelect: true, options: [{ label: 'People' }, { label: 'City' }] },
  {
    header: 'Style',
    question: 'Which style?',
    multiSelect: false,
    options: [
      { label: 'Film', media: { kind: 'image', url: 'https://cdn.test/film.png' } },
      { label: 'Sea', media: { kind: 'video', url: 'https://cdn.test/sea.mp4', poster: 'https://cdn.test/sea.jpg' } },
      { label: 'Beat', media: { kind: 'audio', url: 'https://cdn.test/beat.mp3' } },
    ],
  },
];

afterEach(() => {
  cleanup();
  warning.mockClear();
});

/**
 * A card waiting for the reader.
 * @param onAnswer - Where the answers go.
 * @returns The card's element.
 */
function waitingCard(onAnswer = vi.fn(async () => undefined)): HTMLElement {
  render(<QuestionnaireCard questionnaire={{ toolCallId: 'ask-1', questions: QUESTIONS, state: 'awaiting' }} onAnswer={onAnswer} />);
  return screen.getByTestId('questionnaire-card');
}

/**
 * One question's block on the card.
 * @param n - Which, counting from 1.
 * @returns Its element.
 */
function question(n: number): HTMLElement {
  return screen.getAllByTestId('questionnaire-question')[n - 1]!;
}

describe('a card waiting for the reader', () => {
  it('numbers its questions from 1 in front of each label', () => {
    waitingCard();
    expect(screen.getAllByTestId('questionnaire-question-label').map((el) => el.textContent)).toEqual([
      '1. Ratio',
      '2. Elements',
      '3. Style',
    ]);
  });

  it('picks one option on a single-choice question, moves the pick, and lets go of it on a second click', async () => {
    const user = userEvent.setup();
    waitingCard();
    const [wide, tall] = within(question(1)).getAllByRole('radio');
    await user.click(wide!);
    expect(wide).toHaveAttribute('data-state', 'checked');
    await user.click(tall!);
    expect(wide).toHaveAttribute('data-state', 'unchecked');
    expect(tall).toHaveAttribute('data-state', 'checked');
    await user.click(tall!);
    expect(tall).toHaveAttribute('data-state', 'unchecked');
  });

  it('keeps a single-choice question to one answer: writing on Other clears the pick, and a pick clears Other', async () => {
    const user = userEvent.setup();
    waitingCard();
    const [wide] = within(question(1)).getAllByRole('radio');
    const other = within(question(1)).getByRole('textbox');
    await user.click(wide!);
    await user.type(other, '4:3');
    expect(wide).toHaveAttribute('data-state', 'unchecked');
    await user.click(wide!);
    expect(other).toHaveValue('');
  });

  it('takes several options and words together on a question that takes several', async () => {
    const user = userEvent.setup();
    waitingCard();
    const [people, city] = within(question(2)).getAllByRole('checkbox');
    await user.click(people!);
    await user.click(city!);
    await user.type(within(question(2)).getByRole('textbox'), 'A dog');
    expect(people).toHaveAttribute('data-state', 'checked');
    expect(city).toHaveAttribute('data-state', 'checked');
    expect(within(question(2)).getByRole('textbox')).toHaveValue('A dog');
  });

  it('shows options that carry media as tiles: the picture, the cover of a clip, a sound by its name', async () => {
    waitingCard();
    const tiles = within(question(3)).getAllByTestId('questionnaire-tile');
    expect(tiles.map((t) => t.querySelector('img')?.getAttribute('src') ?? null)).toEqual([
      'https://cdn.test/film.png',
      'https://cdn.test/sea.jpg',
      null,
    ]);
    expect(tiles[2]).toHaveTextContent('Beat');
  });

  it('marks a picked tile with the same check in front of its name a text option has, a click on the picture picking it', async () => {
    const user = userEvent.setup();
    waitingCard();
    const tiles = within(question(3)).getAllByTestId('questionnaire-tile');
    const radios = within(question(3)).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    await user.click(tiles[1]!.querySelector('img')!);
    expect(radios[1]).toHaveAttribute('data-state', 'checked');
    await user.click(tiles[0]!);
    expect(radios[0]).toHaveAttribute('data-state', 'checked');
    expect(radios[1]).toHaveAttribute('data-state', 'unchecked');
    await user.click(radios[0]!);
    expect(radios[0]).toHaveAttribute('data-state', 'unchecked');
  });

  it('marks tiles on a question that takes several with check boxes', async () => {
    const user = userEvent.setup();
    const several: AskUserQuestion = { ...QUESTIONS[2]!, multiSelect: true };
    render(<QuestionnaireCard questionnaire={{ toolCallId: 'ask-1', questions: [several], state: 'awaiting' }} onAnswer={vi.fn()} />);
    const tiles = screen.getAllByTestId('questionnaire-tile');
    await user.click(tiles[0]!);
    await user.click(tiles[2]!);
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('data-state'))).toEqual(['checked', 'unchecked', 'checked']);
  });

  it('says to answer at least one question when nothing is answered, and sends nothing', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn(async () => undefined);
    waitingCard(onAnswer);
    const submit = screen.getByTestId('questionnaire-submit');
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    await user.click(submit);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('sends every answered question at once, leaving the skipped ones out, and waits on the press', async () => {
    const user = userEvent.setup();
    let finish = (): void => undefined;
    const onAnswer = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    waitingCard(onAnswer);
    await user.click(within(question(1)).getAllByRole('radio')[1]!);
    await user.type(within(question(2)).getByRole('textbox'), '  A dog  ');
    await user.click(screen.getByTestId('questionnaire-submit'));

    expect(onAnswer).toHaveBeenCalledWith('ask-1', [
      { index: 0, selected: ['9:16'] },
      { index: 1, selected: [], other: 'A dog' },
    ]);
    expect(screen.getByTestId('questionnaire-submit')).toHaveAttribute('aria-busy', 'true');
    finish();
  });

  it('waits on a turn the conversation is already running, and sends nothing meanwhile', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn(async () => undefined);
    render(
      <QuestionnaireCard
        questionnaire={{ toolCallId: 'ask-1', questions: QUESTIONS, state: 'awaiting' }}
        onAnswer={onAnswer}
        busy
      />,
    );
    await user.click(within(question(1)).getAllByRole('radio')[1]!);
    const submit = screen.getByTestId('questionnaire-submit');
    expect(submit).toHaveAttribute('aria-busy', 'true');
    await user.click(submit);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('carries the hint that a reply in the box will do', () => {
    waitingCard();
    expect(screen.getByTestId('questionnaire-hint')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    waitingCard();
    await expectNoA11yViolations(document.body);
  });
});

describe('model text on the card', () => {
  it('wraps a long word in the question and in an option description', () => {
    const long = `https://example.com/${'a'.repeat(120)}`;
    render(
      <QuestionnaireCard
        questionnaire={{
          toolCallId: 'ask-1',
          questions: [{ header: 'Ref', question: long, multiSelect: false, options: [{ label: 'A', description: `${long}-d` }, { label: 'B' }] }],
          state: 'awaiting',
        }}
      />,
    );
    expect(screen.getByText(long)).toHaveClass('break-words');
    expect(screen.getByText(`${long}-d`)).toHaveClass('break-words');
  });
});

describe('a card already answered', () => {
  it('reads as each question with its answer, a skipped one marked as such', () => {
    render(
      <QuestionnaireCard
        questionnaire={{
          toolCallId: 'ask-1',
          questions: QUESTIONS,
          state: 'answered',
          answers: [
            { index: 0, selected: ['9:16'] },
            { index: 1, selected: ['People', 'City'], other: 'A dog' },
          ],
        }}
      />,
    );
    const rows = screen.getAllByTestId('questionnaire-summary-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('1. Ratio'),
      expect.stringContaining('2. Elements'),
      expect.stringContaining('3. Style'),
    ]);
    expect(rows[0]).toHaveTextContent('9:16');
    expect(rows[1]).toHaveTextContent('People');
    expect(rows[1]).toHaveTextContent('A dog');
    expect(within(rows[2]!).getByTestId('questionnaire-skipped')).toBeInTheDocument();
    expect(screen.queryByTestId('questionnaire-submit')).toBeNull();
  });

  it('joins several answers to one question as a list in the reader\'s language', () => {
    render(
      <QuestionnaireCard
        questionnaire={{
          toolCallId: 'ask-1',
          questions: QUESTIONS,
          state: 'answered',
          answers: [{ index: 1, selected: ['People', 'City'], other: 'A dog' }],
        }}
      />,
    );
    const joined = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(['People', 'City', 'A dog']);

    expect(screen.getByTestId('questionnaire-answer')).toHaveTextContent(joined);
  });

  it('lets a long answer with no spaces wrap inside the card', () => {
    render(
      <QuestionnaireCard
        questionnaire={{
          toolCallId: 'ask-1',
          questions: QUESTIONS,
          state: 'answered',
          answers: [{ index: 0, selected: [], other: `https://example.com/${'a'.repeat(200)}` }],
        }}
      />,
    );

    expect(screen.getByTestId('questionnaire-answer')).toHaveClass('min-w-0', 'break-words');
  });
});

describe('a card the reader replied to in the chat', () => {
  it('is one line until opened, then the questions read-only, and closes again', async () => {
    const user = userEvent.setup();
    render(<QuestionnaireCard questionnaire={{ toolCallId: 'ask-1', questions: QUESTIONS, state: 'replied' }} />);
    const toggle = screen.getByTestId('questionnaire-replied-toggle');
    expect(screen.queryByTestId('questionnaire-readonly')).toBeNull();
    await user.click(toggle);
    const list = screen.getByTestId('questionnaire-readonly');
    expect(within(list).getAllByTestId('questionnaire-question-label').map((el) => el.textContent)).toEqual([
      '1. Ratio',
      '2. Elements',
      '3. Style',
    ]);
    expect(within(list).queryByRole('radio')).toBeNull();
    expect(within(list).queryByRole('textbox')).toBeNull();
    expect(screen.queryByTestId('questionnaire-submit')).toBeNull();
    await user.click(toggle);
    expect(screen.queryByTestId('questionnaire-readonly')).toBeNull();
  });
});
