// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import {
  agreement,
  fixedAnswers,
  judgePrompt,
  parseUserAnswers,
  parseVerdict,
  questionText,
  rowPasses,
  simulatedUserPrompt,
  transcriptOf,
  wilson,
  type CardQuestion,
  type Run,
  type RunStep,
  type Scenario,
} from '../agent-eval';

const scenario: Scenario = {
  id: 'storyboard-cat',
  lang: 'ja',
  text: 'FIRST-MESSAGE make a storyboard about a cat',
  user: 'USER-BRIEF a children book author who wants a warm watercolour look',
  pass: 'PASS-CRITERION the agent asks about the style before placing anything',
};

/**
 * A run made of the given steps, in order.
 * @param steps - What happened in the run, in the order it happened.
 * @returns The run.
 */
function runOf(...steps: RunStep[]): Run {
  return { steps };
}

/**
 * The 95% Wilson score interval computed straight from the formula, z = 1.96.
 * @param passed - Runs that passed.
 * @param total - Runs in all.
 * @returns The low and high ends.
 */
function wilsonByFormula(passed: number, total: number): { low: number; high: number } {
  const z = 1.96;
  const p = passed / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: centre - half, high: centre + half };
}

describe('transcriptOf', () => {
  const run = runOf(
    { kind: 'call', tool: 'ask_user', state: 'output-available', input: { question: 'Q-ONE' } },
    { kind: 'answer', text: 'ANSWER-ONE watercolour' },
    { kind: 'call', tool: 'propose_canvas_action', state: 'output-error', input: { nodes: ['N-TWO'] } },
    { kind: 'text', text: 'REPLY-TEXT here is my plan' },
  );
  const lines = {
    first: `USER: ${scenario.text}`,
    ask: 'TOOL ask_user (output-available): {"question":"Q-ONE"}',
    answer: 'USER ANSWERED: ANSWER-ONE watercolour',
    propose: 'TOOL propose_canvas_action (output-error): {"nodes":["N-TWO"]}',
    reply: 'AGENT: REPLY-TEXT here is my plan',
  };

  it('starts with the first message and writes each step as its own line shape', () => {
    const text = transcriptOf(scenario, run);
    expect(text.startsWith(lines.first)).toBe(true);
    const textLines = text.split('\n');
    for (const line of Object.values(lines)) expect(textLines).toContain(line);
  });

  it('keeps the steps in the order given, an answer between two calls staying between them', () => {
    const text = transcriptOf(scenario, run);
    const order = [lines.first, lines.ask, lines.answer, lines.propose, lines.reply].map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('judgePrompt', () => {
  const run = runOf(
    { kind: 'call', tool: 'ask_user', state: 'output-available', input: { q: 1 } },
    { kind: 'answer', text: 'ANSWER' },
    { kind: 'text', text: 'REPLY-TEXT' },
  );

  it('holds the criterion, the transcript and the answer shape verbatim', () => {
    const prompt = judgePrompt(scenario, run);
    expect(prompt).toContain(scenario.pass);
    expect(prompt).toContain(transcriptOf(scenario, run));
    expect(prompt).toContain('{"pass": boolean, "reason": string}');
  });

  it('fails a run that claims a card or proposal is on screen when none was placed', () => {
    expect(judgePrompt(scenario, runOf({ kind: 'text', text: 'REPLY-TEXT' }))).toContain(
      'Whatever the criterion says, the run fails when the reply says a card or proposal is already on screen and no proposal call is in state output-available.',
    );
  });

  it('says the run is in the order it happened, what the lowest price settings mean and which language the agent writes in', () => {
    const prompt = judgePrompt(scenario, run);
    expect(prompt).toContain(
      'The run is listed in the order it happened: each answer the user gave comes right after the question card it answers.',
    );
    expect(prompt).toContain(
      '"The lowest price settings" means the cheapest value of each setting of the model the agent chose; picking the model the job needs is not a breach.',
    );
    expect(prompt).toContain('The agent writes in the language of the user\'s latest message.');
  });
});

describe('parseVerdict', () => {
  it('reads a bare object', () => {
    expect(parseVerdict('{"pass":true,"reason":"ok"}')).toEqual({ pass: true, reason: 'ok' });
  });

  it('reads an object inside a json fence with text around it', () => {
    const text = 'Here is my verdict:\n```json\n{"pass": false, "reason": "never asked"}\n```\nThanks.';
    expect(parseVerdict(text)).toEqual({ pass: false, reason: 'never asked' });
  });

  it('throws when there is no JSON', () => {
    expect(parseVerdict('{"pass":true,"reason":"ok"}').pass).toBe(true);
    expect(() => parseVerdict('the run passes')).toThrow();
  });

  it('throws when pass is a string', () => {
    expect(parseVerdict('{"pass":true,"reason":"ok"}').pass).toBe(true);
    expect(() => parseVerdict('{"pass":"true","reason":"ok"}')).toThrow();
  });

  it('throws when reason is missing', () => {
    expect(parseVerdict('{"pass":true,"reason":"ok"}').pass).toBe(true);
    expect(() => parseVerdict('{"pass":true}')).toThrow();
  });
});

const questions: CardQuestion[] = [
  { question: 'QUESTION-A which style should the storyboard use?', options: ['OPTION-A-WATERCOLOUR', 'OPTION-A-INK'] },
  { question: 'QUESTION-B how many shots?', options: [] },
  { question: 'QUESTION-C which ratio?', options: ['OPTION-C-WIDE', 'OPTION-C-SQUARE'] },
];

describe('questionText', () => {
  it('numbers each question from 0 and lists its words and every option label, in order', () => {
    const text = questionText(questions);
    const parts = [
      'QUESTION-A which style should the storyboard use?',
      'OPTION-A-WATERCOLOUR',
      'OPTION-A-INK',
      'QUESTION-B how many shots?',
      'QUESTION-C which ratio?',
      'OPTION-C-WIDE',
      'OPTION-C-SQUARE',
    ];
    const order = parts.map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.slice(0, order[0])).toContain('0');
    expect(text.slice(order[2], order[3])).toContain('1');
    expect(text.slice(order[3], order[4])).toContain('2');
  });
});

describe('simulatedUserPrompt', () => {
  it('holds the brief, the language, the questions as text and the answer shape verbatim', () => {
    const prompt = simulatedUserPrompt(scenario, questions);
    expect(prompt).toContain(scenario.user);
    expect(prompt).toContain(scenario.lang);
    expect(prompt).toContain(questionText(questions));
    expect(prompt).toContain('[{"index": number, "choice": string | null, "other": string | null}]');
  });
});

describe('parseUserAnswers', () => {
  const answered = JSON.stringify([
    { index: 2, choice: 'OPTION-C-WIDE', other: null },
    { index: 0, choice: 'a soft pastel look', other: null },
    { index: 1, choice: null, other: 'six shots' },
  ]);

  it('selects a choice that is an option label and puts any other choice or other in words, in index order', () => {
    expect(parseUserAnswers(answered, questions)).toEqual([
      { index: 0, selected: [], other: 'a soft pastel look' },
      { index: 1, selected: [], other: 'six shots' },
      { index: 2, selected: ['OPTION-C-WIDE'] },
    ]);
  });

  it('reads through a json fence with text around it', () => {
    const text = 'My answers:\n```json\n' + answered + '\n```\nDone.';
    expect(parseUserAnswers(text, questions)).toEqual(parseUserAnswers(answered, questions));
  });

  it('throws when there is no array', () => {
    expect(parseUserAnswers(answered, questions)).toHaveLength(3);
    expect(() => parseUserAnswers('watercolour, six shots, wide', questions)).toThrow();
  });

  it('throws on an index that is not one of the questions', () => {
    expect(parseUserAnswers(answered, questions)).toHaveLength(3);
    const text = JSON.stringify([
      { index: 0, choice: 'OPTION-A-INK', other: null },
      { index: 1, choice: null, other: 'six' },
      { index: 2, choice: 'OPTION-C-WIDE', other: null },
      { index: 3, choice: null, other: 'extra' },
    ]);
    expect(() => parseUserAnswers(text, questions)).toThrow();
  });

  it('throws when a question is left unanswered', () => {
    expect(parseUserAnswers(answered, questions)).toHaveLength(3);
    const text = JSON.stringify([
      { index: 0, choice: 'OPTION-A-INK', other: null },
      { index: 2, choice: 'OPTION-C-WIDE', other: null },
    ]);
    expect(() => parseUserAnswers(text, questions)).toThrow();
  });
});

describe('fixedAnswers', () => {
  it('gives every question the words, nothing selected', () => {
    expect(fixedAnswers('FIXED you decide', questions)).toEqual([
      { index: 0, selected: [], other: 'FIXED you decide' },
      { index: 1, selected: [], other: 'FIXED you decide' },
      { index: 2, selected: [], other: 'FIXED you decide' },
    ]);
  });
});

describe('wilson', () => {
  it('gives the formula value for five of five, with the high end at one', () => {
    const { low, high } = wilson(5, 5);
    expect(low).toBeCloseTo(wilsonByFormula(5, 5).low, 3);
    expect(low).toBeCloseTo(0.566, 3);
    expect(high).toBeCloseTo(1, 10);
  });

  it('gives a low end of zero for none of five', () => {
    expect(wilson(0, 5).low).toBeCloseTo(0, 10);
  });

  it('puts four of five strictly inside, at the formula value', () => {
    const { low, high } = wilson(4, 5);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
    expect(low).toBeCloseTo(wilsonByFormula(4, 5).low, 3);
    expect(high).toBeCloseTo(wilsonByFormula(4, 5).high, 3);
  });

  it('keeps the observed rate between the two ends for every count out of twenty', () => {
    for (let passed = 0; passed <= 20; passed++) {
      const { low, high } = wilson(passed, 20);
      const rate = passed / 20;
      expect(low, `${passed}/20 low`).toBeLessThanOrEqual(rate + 1e-12);
      expect(high, `${passed}/20 high`).toBeGreaterThanOrEqual(rate - 1e-12);
      expect(low).toBeGreaterThanOrEqual(-1e-12);
      expect(high).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('throws on a total of zero, a count above the total, a negative count and non-integers', () => {
    expect(wilson(1, 5).low).toBeGreaterThan(0);
    expect(() => wilson(0, 0)).toThrow();
    expect(() => wilson(6, 5)).toThrow();
    expect(() => wilson(-1, 5)).toThrow();
    expect(() => wilson(2.5, 5)).toThrow();
    expect(() => wilson(2, 5.5)).toThrow();
  });
});

describe('rowPasses', () => {
  it('passes at four in five or better and fails below', () => {
    expect(rowPasses(4, 5)).toBe(true);
    expect(rowPasses(5, 5)).toBe(true);
    expect(rowPasses(3, 5)).toBe(false);
    expect(rowPasses(8, 10)).toBe(true);
    expect(rowPasses(7, 10)).toBe(false);
  });
});

describe('agreement', () => {
  it('measures each side on its own runs, with counts', () => {
    const labels = [
      { human: true, judge: true },
      { human: true, judge: true },
      { human: true, judge: true },
      { human: true, judge: false },
      { human: false, judge: false },
      { human: false, judge: true },
    ];
    expect(agreement(labels)).toEqual({ truePass: 0.75, trueFail: 0.5, passes: 4, fails: 2 });
  });

  it('leaves a side with no runs undefined', () => {
    expect(agreement([{ human: true, judge: false }])).toEqual({
      truePass: 0,
      trueFail: undefined,
      passes: 1,
      fails: 0,
    });
    expect(agreement([{ human: false, judge: false }])).toEqual({
      truePass: undefined,
      trueFail: 1,
      passes: 0,
      fails: 1,
    });
    expect(agreement([])).toEqual({ truePass: undefined, trueFail: undefined, passes: 0, fails: 0 });
  });
});
