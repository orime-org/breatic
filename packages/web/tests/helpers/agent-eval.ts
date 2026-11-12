// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The co-create acceptance suite's pure parts (breatic#1361): what one run
 * of a scenario left behind, how a judge model is asked about it and how its
 * answer is read, how a simulated user is asked to answer the agent, and the
 * counting that turns runs into a verdict.
 *
 * The suite follows the usual way of evaluating an agent: a hidden user brief
 * answers the agent's questions, a judge model that is not the model under
 * test decides pass or fail against one written criterion per scenario, the
 * judge is held to hand labels before it is trusted, and a row passes on a
 * share of its runs rather than on every one.
 */

import { ASK_USER_OTHER_MAX_CHARS } from '@breatic/shared';

/** The normal quantile of a two-sided 95% interval. */
const Z = 1.96;
/** The share of a row's runs that must pass: four in five. */
const ROW_SHARE = 0.8;

/**
 * The first JSON value of a kind in a model's words, read through a code fence and text around it.
 * @param text - The words.
 * @param open - The value's opening bracket.
 * @param close - Its closing bracket.
 * @returns The parsed value.
 * @throws {Error} When the words hold no such value.
 */
function jsonIn(text: string, open: string, close: string): unknown {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < start) throw new Error(`no JSON in: ${text}`);
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

/** One scenario of the suite, as `agent-cocreation.scenarios.json` holds it. */
export interface Scenario {
  /** A short stable name. */
  readonly id: string;
  /** The user's language, sent as Accept-Language. */
  readonly lang: string;
  /** The user's first message. */
  readonly text: string;
  /** The Space the Project opens on; canvas when left out. */
  readonly space?: 'canvas' | 'document' | 'timeline' | '3d';
  /** A document's blocks, as type and text, for a document Space. */
  readonly doc?: readonly (readonly [string, string])[];
  /** Pictures attached to the first message. */
  readonly chips?: readonly { readonly id: string; readonly name: string; readonly url: string }[];
  /** What the Space holds, handed over when the agent asks to read it. */
  readonly spaceContent?: string;
  /** Run on the comparison model as well as the default one. */
  readonly compare?: boolean;
  /** Who the user is and what they want, which the agent never sees: the simulated user answers from it. */
  readonly user: string;
  /** Answers given word for word to the first questions, before the simulated user takes over. */
  readonly fixed?: readonly string[];
  /** The Project instructions saved before the first message (#1400). */
  readonly instructions?: string;
  /**
   * A message sent first in another conversation of the same Project, which
   * must make the agent save a memory entry before the judged run starts.
   */
  readonly memory?: string;
  /** What a run must do to pass, as the judge reads it. */
  readonly pass: string;
}

/** One thing that happened in a run, in the order it happened. */
export type RunStep =
  | { readonly kind: 'call'; readonly tool: string; readonly state: string; readonly input: unknown; readonly output?: unknown }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'answer'; readonly text: string };

/** What one run of a scenario left behind: the agent's calls and words and the user's answers, in order, and what it was given. */
export interface Run {
  readonly steps: readonly RunStep[];
  /** Pictures attached to the first message of this run. */
  readonly chips?: Scenario['chips'];
  /** The document this run's Space held. */
  readonly doc?: Scenario['doc'];
}

/** A judge's decision on one run. */
export interface Verdict {
  readonly pass: boolean;
  readonly reason: string;
}

/**
 * The run as the judge reads it: the user's first message with an ATTACHED
 * line for each picture the run was given, the document the run's Space held
 * when it held one, then each step in order, a tool call with its name, state
 * and input as JSON (and what it returned, where that was recorded), the
 * agent's words, or an answer the user gave.
 * @param scenario - The scenario.
 * @param run - The run.
 * @returns The transcript.
 */
export function transcriptOf(scenario: Scenario, run: Run): string {
  const lines = run.steps.map((step) => {
    if (step.kind === 'call') {
      const sent = `TOOL ${step.tool} (${step.state}): ${JSON.stringify(step.input) ?? ''}`;
      if (step.output === undefined) return sent;
      return `${sent}\nRETURNED: ${JSON.stringify(step.output) ?? ''}`;
    }
    return step.kind === 'text' ? `AGENT: ${step.text}` : `USER ANSWERED: ${step.text}`;
  });
  const attached = (run.chips ?? []).map((chip) => `ATTACHED: ${chip.name} ${chip.url}`);
  // Numbered the way the agent receives the open document.
  const doc = run.doc === undefined ? [] : [`OPEN DOCUMENT:\n${run.doc.map(([, text], i) => `<!-- b:${String(i + 1)} -->\n${text}`).join('\n\n')}`];
  return [[`USER: ${scenario.text}`, ...attached].join('\n'), ...doc, ...lines].join('\n\n');
}

/** The tools whose answer says whether the user sees a card. */
const PROPOSAL_TOOLS = new Set(['propose_canvas_action', 'propose_document_edit']);

/**
 * What of a call's answer the judge reads: for `list_generation_models`, each
 * model's name, what it is good at, its speed, its price with the settings it
 * is at, its cheapest settings and the values each setting takes; for a
 * proposal, whether it was placed and, when refused, why.
 * @param tool - The tool called.
 * @param input - What the call sent.
 * @param output - What the tool returned.
 * @returns The slim answer, or undefined when the judge reads none of it.
 */
export function forJudge(tool: string, input: unknown, output: unknown): unknown {
  if (PROPOSAL_TOOLS.has(tool)) {
    const answer = output as { placed?: unknown; reason?: unknown } | null;
    if (typeof answer !== 'object' || answer === null || typeof answer.placed !== 'boolean') return undefined;
    return answer.placed ? { placed: true } : { placed: false, reason: answer.reason };
  }
  return tool === 'list_generation_models' ? modelListForJudge(input, output) : undefined;
}

/**
 * A model list cut to what the judge decides price criteria by. Anything that
 * is not an available model list comes back as it is.
 * @param input - What the call sent.
 * @param output - What `list_generation_models` returned.
 * @returns The slim answer.
 */
function modelListForJudge(input: unknown, output: unknown): unknown {
  const answer = output as { available?: unknown; models?: unknown } | null;
  if (typeof answer !== 'object' || answer === null || answer.available !== true || !Array.isArray(answer.models)) return output;
  type Param = { options?: unknown; min?: unknown; max?: unknown; default?: unknown };
  type Model = { name: unknown; what: unknown; seconds: unknown; price?: unknown; atParams?: unknown; rejected?: unknown; lowestAt?: unknown; params?: Record<string, Param> };
  /**
   * A setting's values and default as the judge reads them.
   * @param spec - The setting.
   * @returns Its values and default, or undefined for one with no values to pick from.
   */
  const setting = (spec: Param): { values: unknown; default?: unknown } | undefined => {
    const values = spec.options ?? (spec.min !== undefined && spec.max !== undefined ? `${String(spec.min)} to ${String(spec.max)}` : undefined);
    if (values === undefined) return undefined;
    return spec.default === undefined ? { values } : { values, default: spec.default };
  };
  const sent = (input as { params?: unknown } | null | undefined)?.params;
  const sentParams = typeof sent === 'object' && sent !== null ? (sent as Record<string, unknown>) : {};
  /**
   * The settings a model was priced at, as far as the judge can read them: the
   * defaults of its readable settings, under the settings the call sent and the
   * model took when the tool says it priced those.
   * @param model - The model.
   * @param params - Its readable settings.
   * @returns Each setting with its value.
   */
  const pricedAt = ({ atParams, rejected }: Model, params: Record<string, { default?: unknown }>): Record<string, unknown> => {
    const defaults = Object.entries(params).flatMap(([key, read]) => ('default' in read ? [[key, read.default]] : []));
    const refused = Array.isArray(rejected) ? rejected : [];
    const taken = atParams === true ? Object.entries(sentParams).filter(([key]) => !refused.includes(key)) : [];
    return Object.fromEntries([...defaults, ...taken]);
  };
  return {
    available: true,
    models: (answer.models as Model[]).map((model) => {
      const params = Object.fromEntries(
        Object.entries(model.params ?? {}).flatMap(([key, spec]) => {
          const read = setting(spec);
          return read === undefined ? [] : [[key, read]];
        }),
      );
      return {
        name: model.name,
        what: model.what,
        seconds: model.seconds,
        ...(model.price === undefined ? {} : { priceAt: { settings: pricedAt(model, params), ...(model.price as object) } }),
        ...(model.rejected === undefined ? {} : { rejected: model.rejected }),
        ...(model.lowestAt === undefined ? {} : { lowestAt: model.lowestAt }),
        params,
      };
    }),
  };
}

/**
 * What the judge is asked: the criterion, the transcript, and to answer with
 * one JSON object `{"pass": boolean, "reason": string}` and nothing else.
 * @param scenario - The scenario.
 * @param run - The run.
 * @returns The prompt.
 */
export function judgePrompt(scenario: Scenario, run: Run): string {
  return [
    'You judge one run of an AI assistant inside a content-creation tool. Decide whether the run meets the criterion below. Judge only what the run shows; tool calls are listed with their inputs.',
    `CRITERION:\n${scenario.pass}`,
    'Whatever the criterion says, the run fails when the reply says a card or proposal is already on screen and no proposal call is in state output-available.',
    'The run is listed in the order it happened: each answer the user gave comes right after the question card it answers.',
    '"The lowest price settings" means the cheapest value of each setting of the model the agent chose; picking the model the job needs is not a breach.',
    'The agent writes in the language of the user\'s latest message.',
    'An answer on a question card is not a message: a few words in another language there do not change the user\'s language.',
    'When the user says they will send something, waiting for it before making anything it could change, the look included, is right.',
    'Judge a stated price only against a RETURNED price for the same model and settings; a price for settings the run never priced is not a breach.',
    'A proposal call is a card the user sees when it is in state output-available, unless its RETURNED line says placed false: that proposal was refused and the user never sees it.',
    'A TOOL line shows what the agent sent; null means the input was not recorded. A RETURNED line under it shows what came back, where it was recorded.',
    `RUN:\n${transcriptOf(scenario, run)}`,
    'Answer with one JSON object {"pass": boolean, "reason": string} and nothing else; the reason is one sentence naming what decided it.',
  ].join('\n\n');
}

/**
 * The judge's answer read back. A fenced code block around the object is
 * read through; anything else is not an answer.
 * @param text - What the judge wrote.
 * @returns The verdict.
 * @throws {Error} When the text holds no such object, or `pass` is not a boolean or `reason` not a string.
 */
export function parseVerdict(text: string): Verdict {
  const read = jsonIn(text, '{', '}') as { pass?: unknown; reason?: unknown };
  if (typeof read.pass !== 'boolean' || typeof read.reason !== 'string') throw new Error(`not a verdict: ${text}`);
  return { pass: read.pass, reason: read.reason };
}

/** One question of the agent's question card. */
export interface CardQuestion {
  readonly question: string;
  /** The options it offers, by label; empty for a question answered in words. */
  readonly options: readonly string[];
}

/** One answer on the question card, as the chat route takes it. */
export interface CardAnswer {
  readonly index: number;
  readonly selected: string[];
  readonly other?: string;
}

/**
 * The question card as text: each question numbered from 0, with its options.
 * @param questions - The card's questions.
 * @returns One block per question, its index, its words and each option label.
 */
export function questionText(questions: readonly CardQuestion[]): string {
  return questions
    .map((one, index) => [`${String(index)}. ${one.question}`, ...one.options.map((option) => `   - ${option}`)].join('\n'))
    .join('\n');
}

/**
 * What the simulated user is asked: to answer the agent's questions as the
 * user the brief describes, in the scenario's language, briefly, saying only
 * what the brief gives and "you decide" for what it does not, as one JSON
 * array `[{"index": number, "choice": string | null, "other": string | null}]`
 * and nothing else.
 * @param scenario - The scenario.
 * @param questions - The agent's question card.
 * @returns The prompt, holding the brief, the lang code and {@link questionText}.
 */
export function simulatedUserPrompt(scenario: Scenario, questions: readonly CardQuestion[]): string {
  return [
    'You play the user of a content-creation tool, answering the assistant\'s questions. Answer as the user described below, briefly, from what the description gives; for anything it does not give, answer "you decide" in your language.',
    `YOUR LANGUAGE: ${scenario.lang}`,
    `WHO YOU ARE (the assistant never sees this):\n${scenario.user}`,
    `THE ASSISTANT'S QUESTIONS:\n${questionText(questions)}`,
    'Answer every question, as one JSON array [{"index": number, "choice": string | null, "other": string | null}] and nothing else: choice is an option label copied exactly, other is your own words.',
  ].join('\n\n');
}

/**
 * The simulated user's answer read back into the card's answers. A choice
 * that is one of the question's option labels is selected; any other choice,
 * or `other`, goes in as words, cut to what the chat route takes; an answer
 * with no words leaves `other` out. A fenced code block around the array is
 * read through.
 * @param text - What the simulated user wrote.
 * @param questions - The card's questions.
 * @returns One answer per question, in index order.
 * @throws {Error} When the text holds no array, an entry's index is not one of the questions', or some question has no answer.
 */
export function parseUserAnswers(text: string, questions: readonly CardQuestion[]): CardAnswer[] {
  const read = jsonIn(text, '[', ']');
  if (!Array.isArray(read)) throw new Error(`not an answer list: ${text}`);
  const answers = new Map<number, CardAnswer>();
  for (const entry of read as { index?: unknown; choice?: unknown; other?: unknown }[]) {
    const question = typeof entry.index === 'number' ? questions[entry.index] : undefined;
    if (question === undefined || typeof entry.index !== 'number') throw new Error(`no question ${String(entry.index)}`);
    const choice = typeof entry.choice === 'string' ? entry.choice : undefined;
    if (choice !== undefined && question.options.includes(choice)) answers.set(entry.index, { index: entry.index, selected: [choice] });
    else {
      // The chat route rejects an empty other and one past its cap.
      const words = [entry.other, choice].find((one): one is string => typeof one === 'string' && one.trim() !== '')?.slice(0, ASK_USER_OTHER_MAX_CHARS);
      answers.set(entry.index, words === undefined ? { index: entry.index, selected: [] } : { index: entry.index, selected: [], other: words });
    }
  }
  return questions.map((_, index) => {
    const answer = answers.get(index);
    if (answer === undefined) throw new Error(`question ${String(index)} has no answer`);
    return answer;
  });
}

/**
 * A fixed reply given to every question of a card, in words.
 * @param words - The reply.
 * @param questions - The card's questions.
 * @returns One answer per question, nothing selected, the words as `other`.
 */
export function fixedAnswers(words: string, questions: readonly CardQuestion[]): CardAnswer[] {
  return questions.map((_, index) => ({ index, selected: [], other: words }));
}

/**
 * The 95% Wilson score interval of a pass rate.
 * @param passed - Runs that passed.
 * @param total - Runs in all.
 * @returns The low and high ends, each in [0, 1].
 * @throws {Error} When total is not a positive integer or passed lies outside 0..total.
 */
export function wilson(passed: number, total: number): { low: number; high: number } {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(passed) || passed < 0 || passed > total) {
    throw new Error(`not a pass count: ${String(passed)} of ${String(total)}`);
  }
  const p = passed / total;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * total)) / (1 + z2 / total);
  const spread = (Z / (1 + z2 / total)) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/**
 * Whether a scenario's row passes on one model: at least four runs in five.
 * @param passed - Runs that passed.
 * @param total - Runs in all.
 * @returns True when passed / total is at least 0.8.
 */
export function rowPasses(passed: number, total: number): boolean {
  return total > 0 && passed / total >= ROW_SHARE;
}

/**
 * How a judge agrees with hand labels, each side on its own: the share of
 * runs a person passed that the judge passed, and of runs a person failed
 * that the judge failed.
 * @param labels - Each run's two decisions.
 * @returns The two shares, undefined where a side has no runs, and how many runs each counts.
 */
export function agreement(labels: readonly { human: boolean; judge: boolean }[]): {
  truePass: number | undefined;
  trueFail: number | undefined;
  passes: number;
  fails: number;
} {
  const passes = labels.filter((one) => one.human);
  const fails = labels.filter((one) => !one.human);
  return {
    truePass: passes.length === 0 ? undefined : passes.filter((one) => one.judge).length / passes.length,
    trueFail: fails.length === 0 ? undefined : fails.filter((one) => !one.judge).length / fails.length,
    passes: passes.length,
    fails: fails.length,
  };
}

/**
 * {@link agreement} for each scenario's own labels.
 * @param labels - Each run's scenario and two decisions.
 * @returns The scenario's numbers, by scenario.
 */
export function agreementByScenario(labels: readonly { scenario: string; human: boolean; judge: boolean }[]): Map<string, ReturnType<typeof agreement>> {
  const byScenario = Map.groupBy(labels, (one) => one.scenario);
  return new Map([...byScenario].map(([scenario, own]) => [scenario, agreement(own)]));
}
