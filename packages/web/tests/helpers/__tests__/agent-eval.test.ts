// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { ASK_USER_OTHER_MAX_CHARS } from '@breatic/shared';
import { describe, expect, it } from 'vitest';

import {
  agreement,
  agreementByScenario,
  fixedAnswers,
  forJudge,
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

  /**
   * The first line that is not empty after the given line of the transcript.
   * @param text - The transcript.
   * @param line - A line the transcript holds.
   * @returns The line after it, or undefined when there is none.
   */
  function lineAfter(text: string, line: string): string | undefined {
    const textLines = text.split('\n');
    const at = textLines.indexOf(line);
    expect(at).toBeGreaterThanOrEqual(0);
    return textLines.slice(at + 1).find((one) => one !== '');
  }

  it('writes what a call returned on a RETURNED line right under its TOOL line, and nothing under a call without output', () => {
    const text = transcriptOf(
      scenario,
      runOf(
        {
          kind: 'call',
          tool: 'list_models',
          state: 'output-available',
          input: { kind: 'video' },
          output: { models: [{ id: 'MODEL-FAST', price: 'PRICE-LOW' }] },
        },
        { kind: 'call', tool: 'ask_user', state: 'output-available', input: { question: 'Q-ONE' } },
        { kind: 'text', text: 'REPLY-TEXT' },
      ),
    );
    expect(lineAfter(text, 'TOOL list_models (output-available): {"kind":"video"}')).toBe(
      'RETURNED: {"models":[{"id":"MODEL-FAST","price":"PRICE-LOW"}]}',
    );
    expect(lineAfter(text, lines.ask)).toBe('AGENT: REPLY-TEXT');
    expect(text.split('\n').filter((one) => one.startsWith('RETURNED: '))).toHaveLength(1);
  });

  it('writes a refused proposal call with its placed false answer on the RETURNED line', () => {
    const text = transcriptOf(
      scenario,
      runOf({ kind: 'call', tool: 'propose_canvas_action', state: 'output-available', input: { nodes: ['N-TWO'] }, output: { placed: false, reason: 'R' } }),
    );
    expect(lineAfter(text, 'TOOL propose_canvas_action (output-available): {"nodes":["N-TWO"]}')).toBe('RETURNED: {"placed":false,"reason":"R"}');
  });

  it('writes a RETURNED line of 20000 characters whole, with no ellipsis', () => {
    const long = 'y'.repeat(20000);
    const text = transcriptOf(scenario, runOf({ kind: 'call', tool: 'list_models', state: 'output-available', input: null, output: long }));
    expect(lineAfter(text, 'TOOL list_models (output-available): null')).toBe(`RETURNED: ${JSON.stringify(long)}`);
    expect(text).not.toContain('\u2026');
  });

  it('renders a scenario without doc or chips as the first message then the steps, nothing between', () => {
    expect(transcriptOf(scenario, run)).toBe([lines.first, lines.ask, lines.answer, lines.propose, lines.reply].join('\n\n'));
  });

  const chips = [
    { id: 'CHIP-ID-ONE', name: 'CHIP-NAME-ONE', url: 'https://example.test/one.png' },
    { id: 'CHIP-ID-TWO', name: 'CHIP-NAME-TWO', url: 'https://example.test/two.png' },
  ];
  const doc: [string, string][] = [
    ['heading', 'DOC-TEXT-ONE the title'],
    ['paragraph', 'DOC-TEXT-TWO the body'],
    ['paragraph', 'DOC-TEXT-THREE the end'],
  ];
  const documentScenario: Scenario = { ...scenario, space: 'document' };
  const withMaterial: Run = { ...run, chips, doc };

  it('writes one ATTACHED line per chip the run was given, its name and url, after the first message and before the steps', () => {
    const text = transcriptOf(documentScenario, withMaterial);
    const textLines = text.split('\n');
    const one = 'ATTACHED: CHIP-NAME-ONE https://example.test/one.png';
    const two = 'ATTACHED: CHIP-NAME-TWO https://example.test/two.png';
    expect(textLines).toContain(one);
    expect(textLines).toContain(two);
    expect(textLines.filter((line) => line.startsWith('ATTACHED: '))).toHaveLength(2);
    const order = [lines.first, one, two, lines.ask].map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('writes the open document the run was given once, each block numbered from 1 as the agent receives it, after the first message and before the steps', () => {
    const text = transcriptOf(documentScenario, withMaterial);
    const blocks = '<!-- b:1 -->\nDOC-TEXT-ONE the title\n\n<!-- b:2 -->\nDOC-TEXT-TWO the body\n\n<!-- b:3 -->\nDOC-TEXT-THREE the end';
    expect(text).toContain(blocks);
    expect(text.split('\n').filter((line) => line === 'OPEN DOCUMENT:')).toHaveLength(1);
    const order = [lines.first, 'OPEN DOCUMENT:', blocks, lines.ask].map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toContain('<!-- b:0 -->');
    expect(text).not.toContain('<!-- b:4 -->');
  });

  it('writes chips without a document block, and a document without ATTACHED lines', () => {
    const chipsOnly = transcriptOf(documentScenario, { ...run, chips });
    expect(chipsOnly).toContain('ATTACHED: CHIP-NAME-ONE https://example.test/one.png');
    expect(chipsOnly).not.toContain('OPEN DOCUMENT:');
    const docOnly = transcriptOf(documentScenario, { ...run, doc });
    expect(docOnly).toContain('OPEN DOCUMENT:');
    expect(docOnly).not.toContain('ATTACHED: ');
  });

  it('ignores the scenario\'s chips and document when the run was not given them', () => {
    const text = transcriptOf({ ...documentScenario, chips, doc }, run);
    expect(text).toBe([lines.first, lines.ask, lines.answer, lines.propose, lines.reply].join('\n\n'));
    expect(text).not.toContain('ATTACHED: ');
    expect(text).not.toContain('OPEN DOCUMENT:');
  });

  it('writes the run\'s chips and document, not the scenario\'s, when the two differ, and still takes the first message from the scenario', () => {
    const fromScenario: Scenario = {
      ...documentScenario,
      chips: [{ id: 'SCENARIO-CHIP-ID', name: 'SCENARIO-CHIP-NAME', url: 'https://example.test/scenario.png' }],
      doc: [['paragraph', 'SCENARIO-DOC-TEXT']],
    };
    const text = transcriptOf(fromScenario, withMaterial);
    expect(text.startsWith(lines.first)).toBe(true);
    expect(text).toContain('ATTACHED: CHIP-NAME-ONE https://example.test/one.png');
    expect(text).toContain('DOC-TEXT-ONE the title');
    expect(text).not.toContain('SCENARIO-CHIP-NAME');
    expect(text).not.toContain('SCENARIO-DOC-TEXT');
  });
});

describe('forJudge', () => {
  const full = {
    available: true,
    models: [
      {
        name: 'MODEL-FAST',
        displayName: 'DISPLAY-FAST',
        what: 'WHAT-FAST a quick video model',
        seconds: [5, 10],
        price: { credits: 40, bound: 'upper' },
        atParams: true,
        rejected: ['resolution', 'quality'],
        lowestAt: { resolution: '480p' },
        vendor: 'VENDOR-DROPPED',
        params: {
          resolution: { what: 'PARAM-WHAT-DROPPED', options: ['480p', '720p'], default: '720p' },
          duration: { what: 'PARAM-WHAT-DROPPED', min: 2, max: 12, default: 5, needs: 'NEEDS-DROPPED' },
          seed: { what: 'PARAM-WHAT-DROPPED', min: 0 },
          prompt_extend: { what: 'PARAM-WHAT-DROPPED', default: true },
        },
      },
      {
        name: 'MODEL-DEFAULTS',
        what: 'WHAT-DEFAULTS',
        seconds: 6,
        price: { credits: 12, bound: 'exact' },
        params: { quality: { what: 'PARAM-WHAT-DROPPED', options: ['low', 'high'], default: 'low' } },
      },
      {
        name: 'MODEL-PLAIN',
        what: 'WHAT-PLAIN',
        seconds: 8,
        params: { ratio: { options: ['16:9', '9:16'], needs: 'NEEDS-DROPPED' } },
      },
    ],
  };

  const sent = { kind: 'video', params: { resolution: '1080p', duration: 10, quality: 'high' } };

  it('keeps each model\'s name, what, seconds, price with the settings it is at, rejected, lowestAt and each param\'s values and default', () => {
    expect(forJudge('list_generation_models', sent, full)).toEqual({
      available: true,
      models: [
        {
          name: 'MODEL-FAST',
          what: 'WHAT-FAST a quick video model',
          seconds: [5, 10],
          priceAt: { settings: { resolution: '720p', duration: 10, prompt_extend: true }, credits: 40, bound: 'upper' },
          rejected: ['resolution', 'quality'],
          lowestAt: { resolution: '480p' },
          params: {
            resolution: { values: ['480p', '720p'], default: '720p' },
            duration: { values: '2 to 12', default: 5 },
          },
        },
        {
          name: 'MODEL-DEFAULTS',
          what: 'WHAT-DEFAULTS',
          seconds: 6,
          priceAt: { settings: { quality: 'low' }, credits: 12, bound: 'exact' },
          params: { quality: { values: ['low', 'high'], default: 'low' } },
        },
        { name: 'MODEL-PLAIN', what: 'WHAT-PLAIN', seconds: 8, params: { ratio: { values: ['16:9', '9:16'] } } },
      ],
    });
  });

  describe('priceAt', () => {
    const params = {
      size: { options: ['S', 'L'], default: 'S' },
      steps: { min: 1, max: 9, default: 4 },
      style: { options: ['flat', 'ink'] },
      boost: { default: false },
      seed: { min: 0 },
    };
    const price = { credits: 7, bound: 'exact' };
    /**
     * The one model of a list holding it, as the judge reads it.
     * @param input - What the call sent.
     * @param extra - Fields added to the model.
     * @returns The slim model.
     */
    const one = (input: unknown, extra: Record<string, unknown>): Record<string, unknown> => {
      const slim = forJudge('list_generation_models', input, { available: true, models: [{ name: 'M', what: 'W', seconds: 1, params, ...extra }] }) as { models: Record<string, unknown>[] };
      return slim.models[0];
    };

    it('is every default overlaid with the params sent when atParams is true', () => {
      expect(one({ params: { size: 'L', steps: 9, style: 'ink' } }, { price, atParams: true })).toHaveProperty('priceAt', {
        settings: { size: 'L', steps: 9, style: 'ink', boost: false },
        credits: 7,
        bound: 'exact',
      });
    });

    it('leaves out a sent key the model rejected, showing its default instead when it has one', () => {
      const model = one({ params: { size: 'L', steps: 9, style: 'ink' } }, { price, atParams: true, rejected: ['size', 'style'] });
      expect(model).toHaveProperty('priceAt', { settings: { size: 'S', steps: 9, boost: false }, credits: 7, bound: 'exact' });
      expect((model.priceAt as { settings: object }).settings).not.toHaveProperty('style');
    });

    it('is the defaults alone when atParams is not true, even when the call sent params', () => {
      for (const extra of [{}, { atParams: false }, { atParams: 'true' }]) {
        expect(one({ params: { size: 'L', style: 'ink' } }, { price, ...extra }), JSON.stringify(extra)).toHaveProperty('priceAt', {
          settings: { size: 'S', steps: 4, boost: false },
          credits: 7,
          bound: 'exact',
        });
      }
    });

    it('is the defaults when the input is missing or sent no params', () => {
      for (const input of [null, undefined, {}, { kind: 'image' }, { params: undefined }]) {
        for (const extra of [{}, { atParams: true }]) {
          expect(one(input, { price, ...extra }), JSON.stringify({ input, extra })).toHaveProperty('priceAt', {
            settings: { size: 'S', steps: 4, boost: false },
            credits: 7,
            bound: 'exact',
          });
        }
      }
    });

    it('is absent for a model without a price, and the old price keys are never written', () => {
      for (const extra of [{}, { atParams: true }]) {
        const model = one({ params: { size: 'L' } }, extra);
        expect(model).not.toHaveProperty('priceAt');
      }
      const priced = one({ params: { size: 'L' } }, { price, atParams: true });
      expect(priced).not.toHaveProperty('priceAtSettingsSent');
      expect(priced).not.toHaveProperty('priceAtDefaults');
    });
  });

  it('drops every other field of a model and of its params, and leaves absent keys absent', () => {
    const slim = forJudge('list_generation_models', sent, full) as { models: Record<string, unknown>[] };
    const text = JSON.stringify(slim);
    for (const dropped of ['DISPLAY-FAST', 'VENDOR-DROPPED', 'PARAM-WHAT-DROPPED', 'NEEDS-DROPPED', 'seed', 'atParams', '"price"', '"what":"PARAM']) {
      expect(text, dropped).not.toContain(dropped);
    }
    expect(slim.models[0].params).not.toHaveProperty('prompt_extend');
    for (const model of slim.models.slice(1)) {
      expect(model).not.toHaveProperty('rejected');
      expect(model).not.toHaveProperty('lowestAt');
    }
    const plain = slim.models[2];
    expect(plain).not.toHaveProperty('priceAt');
    expect((plain.params as Record<string, object>).ratio).not.toHaveProperty('default');
  });

  it('returns anything that is not an available model list unchanged', () => {
    const unavailable = { available: false, offered: ['MODEL-A', 'MODEL-B'] };
    expect(forJudge('list_generation_models', sent, unavailable)).toEqual(unavailable);
    for (const other of [null, undefined, 'TEXT', 42, [1, 2], { models: 'not-a-list' }]) {
      expect(forJudge('list_generation_models', sent, other)).toEqual(other);
    }
  });

  for (const tool of ['propose_canvas_action', 'propose_document_edit']) {
    it(`keeps only placed true from a placed ${tool} answer`, () => {
      expect(forJudge(tool, { nodes: ['NODE-SENT'] }, { placed: true, proposalId: 'PROPOSAL-ID', nodes: ['NODE-DROPPED'], summary: 'SUMMARY-DROPPED' })).toEqual({ placed: true });
    });

    it(`keeps placed false and the reason of a refused ${tool} answer`, () => {
      expect(forJudge(tool, { nodes: ['NODE-SENT'] }, { placed: false, reason: 'REASON-REFUSED', extra: 'EXTRA-DROPPED' })).toEqual({ placed: false, reason: 'REASON-REFUSED' });
    });

    it(`records nothing for a ${tool} answer without a boolean placed`, () => {
      for (const other of [null, undefined, 'TEXT', { reason: 'REASON-ONLY' }, { placed: 'yes' }]) {
        expect(forJudge(tool, { nodes: ['NODE-SENT'] }, other)).toBeUndefined();
      }
    });
  }

  it('records nothing for any other tool', () => {
    for (const tool of ['ask_user', 'list_models', 'read_document']) {
      expect(forJudge(tool, sent, { placed: true })).toBeUndefined();
      expect(forJudge(tool, sent, full)).toBeUndefined();
    }
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

  it('says a TOOL line shows what was sent and a RETURNED line under it shows what came back', () => {
    const prompt = judgePrompt(scenario, run);
    expect(prompt).not.toContain(
      'A TOOL line shows what the agent sent, not what came back; null means the input was not recorded.',
    );
    expect(prompt).toContain(
      'A TOOL line shows what the agent sent; null means the input was not recorded. A RETURNED line under it shows what came back, where it was recorded.',
    );
  });

  it('says a proposal call is a card only when its RETURNED line does not say placed false', () => {
    const prompt = judgePrompt(scenario, run);
    expect(prompt).not.toContain('a proposal call in state output-available is a card the user sees');
    expect(prompt).toContain(
      'A proposal call is a card the user sees when it is in state output-available, unless its RETURNED line says placed false: that proposal was refused and the user never sees it.',
    );
  });

  it('says a stated price is judged only against a returned price for the same model and settings', () => {
    expect(judgePrompt(scenario, run)).toContain(
      'Judge a stated price only against a RETURNED price for the same model and settings; a price for settings the run never priced is not a breach.',
    );
  });

  it('says waiting for something the user will send is right', () => {
    expect(judgePrompt(scenario, run)).toContain(
      'When the user says they will send something, waiting for it before making anything it could change, the look included, is right.',
    );
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

  it('leaves other out when the answer has neither a choice nor words, since the chat route rejects an empty other', () => {
    const answers = parseUserAnswers('[{"index":0,"choice":null,"other":null}]', [{ question: 'q', options: ['A'] }]);
    expect(answers).toEqual([{ index: 0, selected: [] }]);
    expect(answers[0]).not.toHaveProperty('other');
  });

  it('treats an other of only spaces as empty', () => {
    const answers = parseUserAnswers('[{"index":0,"choice":null,"other":"   "}]', [{ question: 'q', options: ['A'] }]);
    expect(answers).toEqual([{ index: 0, selected: [] }]);
    expect(answers[0]).not.toHaveProperty('other');
  });

  it('cuts an other longer than 500 characters to 500', () => {
    const long = 'w'.repeat(501);
    const answers = parseUserAnswers(JSON.stringify([{ index: 0, choice: null, other: long }]), [{ question: 'q', options: ['A'] }]);
    expect(answers).toEqual([{ index: 0, selected: [], other: long.slice(0, 500) }]);
  });

  it('falls back to a non-blank choice that is not an option when other is blank', () => {
    const one: CardQuestion[] = [{ question: 'q', options: ['A'] }];
    for (const other of [null, '', '   ']) {
      expect(parseUserAnswers(JSON.stringify([{ index: 0, choice: 'CHOICE-WORDS', other }]), one), String(other)).toEqual([
        { index: 0, selected: [], other: 'CHOICE-WORDS' },
      ]);
    }
  });

  it('gives nothing selected and no other key when both choice and other are blank', () => {
    const answers = parseUserAnswers('[{"index":0,"choice":"  ","other":""}]', [{ question: 'q', options: ['A'] }]);
    expect(answers).toEqual([{ index: 0, selected: [] }]);
    expect(answers[0]).not.toHaveProperty('other');
  });

  it('cuts words from either other or a fallback choice to ASK_USER_OTHER_MAX_CHARS', () => {
    const one: CardQuestion[] = [{ question: 'q', options: ['A'] }];
    const long = 'z'.repeat(ASK_USER_OTHER_MAX_CHARS + 10);
    const cut = [{ index: 0, selected: [], other: long.slice(0, ASK_USER_OTHER_MAX_CHARS) }];
    expect(parseUserAnswers(JSON.stringify([{ index: 0, choice: null, other: long }]), one)).toEqual(cut);
    expect(parseUserAnswers(JSON.stringify([{ index: 0, choice: long, other: null }]), one)).toEqual(cut);
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

describe('agreementByScenario', () => {
  const labels = [
    { scenario: 'SCENARIO-A', human: true, judge: true },
    { scenario: 'SCENARIO-B', human: false, judge: true },
    { scenario: 'SCENARIO-A', human: true, judge: false },
    { scenario: 'SCENARIO-A', human: false, judge: false },
    { scenario: 'SCENARIO-B', human: false, judge: false },
  ];

  it('gives each scenario the numbers agreement gives its own runs', () => {
    const byScenario = agreementByScenario(labels);
    expect([...byScenario.keys()].sort()).toEqual(['SCENARIO-A', 'SCENARIO-B']);
    expect(byScenario.get('SCENARIO-A')).toEqual({ truePass: 0.5, trueFail: 1, passes: 2, fails: 1 });
    expect(byScenario.get('SCENARIO-B')).toEqual({ truePass: undefined, trueFail: 0.5, passes: 0, fails: 2 });
    for (const [scenario, numbers] of byScenario) {
      expect(numbers, scenario).toEqual(agreement(labels.filter((one) => one.scenario === scenario)));
    }
  });

  it('has no scenario when there are no labels', () => {
    expect(agreementByScenario([]).size).toBe(0);
  });
});
