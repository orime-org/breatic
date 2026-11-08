// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The co-create acceptance suite (breatic#1361): does the agent, on a real
 * model, ask what only the user knows, offer cheap takes for taste, answer a
 * question and stop, and say a model's limit is the model's?
 *
 * Each scenario of `agent-cocreation.scenarios.json` is sent several times,
 * each time to a fresh Project and conversation over the HTTP API. When a
 * turn stops at a question card, a simulated user answers from a brief the
 * agent never sees (the scenario's `fixed` answers come first); a request to
 * read Spaces is answered by sharing the Space. A judge model, not the model
 * under test, then decides each run against the scenario's written criterion,
 * and fails a reply that says a card is on screen when no proposal placed one. A row
 * passes on four runs in five; the run also prints each model's overall pass
 * rate with its 95% interval, for comparing a change with the one before it.
 *
 * Unit tests pin what the prompt and the tools say; only real turns show
 * what a model does with them, and a model's output varies from run to run,
 * hence rates rather than single runs. The judge is held to hand labels by
 * the last case before its verdicts are trusted.
 *
 * Run it after changing the system prompt or a tool's description:
 *   pnpm --filter @breatic/web exec playwright test --project=smoke --workers=1 tests/smoke/agent-cocreation.spec.ts
 * It needs OPENROUTER_API_KEY for the simulated user and the judge, read from
 * the environment or from the repository's `.env`. EVAL_ONLY (scenario ids,
 * comma-separated) and EVAL_RUNS narrow a run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, request, type APIRequestContext } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { stateFile, test } from '../helpers/slot';
import {
  agreement,
  agreementByScenario,
  fixedAnswers,
  judgePrompt,
  parseUserAnswers,
  parseVerdict,
  rowPasses,
  simulatedUserPrompt,
  wilson,
  type CardAnswer,
  type CardQuestion,
  type Run,
  type RunStep,
  type Scenario,
  type Verdict,
} from '../helpers/agent-eval';

const ROOT_ENV = join(__dirname, '../../../../.env');
if (process.env.OPENROUTER_API_KEY === undefined && existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

const SCENARIOS = (JSON.parse(readFileSync(join(__dirname, 'agent-cocreation.scenarios.json'), 'utf8')) as Scenario[]).filter(
  (one) => (process.env.EVAL_ONLY ?? '') === '' || (process.env.EVAL_ONLY ?? '').split(',').includes(one.id),
);
const RUNS = Number(process.env.EVAL_RUNS ?? '5');
/** The model a conversation runs on when it names none: the deployment's default. */
const DEFAULT_MODEL = undefined;
/** The model the rows marked `compare` run on as well. */
const COMPARE_MODEL = process.env.EVAL_COMPARE_MODEL ?? 'anthropic/claude-sonnet-5.5';
/** The simulated user and the judge: a model neither run under test uses. */
const HELPER_MODEL = process.env.EVAL_HELPER_MODEL ?? 'google/gemini-3.8-flash';
/** Turns run at once on the slot's account. */
const AT_ONCE = Number(process.env.EVAL_AT_ONCE ?? '6');
/** How many cards a run answers before it is read. */
const FOLLOW_UPS = 2;
/** Hand labels, one JSON object a line: the scenario, its criterion's {@link criterionOf}, the run and the person's verdict. */
const LABELS = join(__dirname, 'agent-cocreation.labels.jsonl');

/** The zone a user writing each language would most likely report, as a browser does. */
const TIME_ZONES: Readonly<Record<string, string>> = {
  'zh-CN': 'Asia/Shanghai',
  'zh-TW': 'Asia/Taipei',
  ja: 'Asia/Tokyo',
  ko: 'Asia/Seoul',
  en: 'America/New_York',
};

/** The parts of a stored message this suite reads. */
interface StoredPart {
  readonly type?: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly state?: string;
  readonly status?: string;
  readonly input?: {
    questions?: { question?: string; options?: (string | { label?: string })[] }[];
    spaces?: { id?: string; blocks?: { from: number; to?: number }; node_ids?: string[] }[];
  };
}

/**
 * The tool a stored part is a call of.
 * @param part - The part.
 * @returns The tool's name, or undefined for a part that is no call.
 */
function toolOf(part: StoredPart): string | undefined {
  if (part.type === 'tool') return part.toolName;
  return part.type?.startsWith('tool-') === true ? part.type.slice('tool-'.length) : undefined;
}

/**
 * Ask a helper model one thing and read its words.
 * @param api - A request context for the model provider.
 * @param prompt - The prompt.
 * @param asObject - Ask for one JSON object as the whole answer, as the judge answers.
 * @returns What the model wrote.
 * @throws {Error} When the provider refuses the call.
 */
async function askHelper(api: APIRequestContext, prompt: string, asObject = false): Promise<string> {
  // One retry, after the provider's Retry-After or five seconds: an empty or
  // refused answer is the helper's failure, not the agent's.
  for (let attempt = 0; ; attempt += 1) {
    const res = await api.post('https://openrouter.ai/api/v1/chat/completions', {
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}` },
      data: {
        model: HELPER_MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        ...(asObject ? { response_format: { type: 'json_object' } } : {}),
      },
      timeout: 120_000,
    });
    const content = res.ok() ? ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '' : '';
    if (content !== '') return content;
    if (attempt >= 1) throw new Error(`helper model: ${String(res.status())} ${res.ok() ? 'empty answer' : await res.text()}`);
    const wait = Number(res.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(wait) && wait > 0 ? wait : 5) * 1000));
  }
}

/**
 * Send one message to the chat route and read the stream to its end.
 * @param api - The signed-in request context.
 * @param scenario - The scenario, for its language.
 * @param body - The request body.
 * @throws {Error} When the route refuses the message.
 */
async function send(api: APIRequestContext, scenario: Scenario, body: Record<string, unknown>): Promise<void> {
  const res = await api.post('/api/v1/chat/message', {
    headers: { accept: 'text/event-stream', 'Accept-Language': scenario.lang },
    data: body,
    timeout: 600_000,
  });
  if (!res.ok()) throw new Error(`chat message: ${String(res.status())} ${await res.text()}`);
}

/**
 * Create a Project, waiting out the per-account creation limit when a run of
 * many turns reaches it.
 * @param api - The signed-in request context.
 * @param data - The Project to create.
 * @returns The Project.
 * @throws {Error} When creation keeps failing.
 */
async function createProject(api: APIRequestContext, data: Record<string, unknown>): Promise<{ id: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const res = await api.post('/api/v1/projects', { headers: { 'Idempotency-Key': randomUUID() }, data });
    if (res.status() !== 429) return dataOf<{ id: string }>(res, 'create project');
    const wait = Number(res.headers()['retry-after'] ?? '10');
    await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(wait) && wait > 0 ? wait : 10) * 1000));
  }
  throw new Error('create project: still limited after 30 tries');
}

/**
 * One run of a scenario: a new Project and conversation, the first message,
 * and up to {@link FOLLOW_UPS} cards answered.
 * @param api - The signed-in request context.
 * @param helper - A request context for the helper model.
 * @param studioId - The account's personal Studio.
 * @param scenario - The scenario.
 * @param model - The model to run on, or undefined for the default.
 * @returns What the run left behind, in order.
 */
async function runOnce(api: APIRequestContext, helper: APIRequestContext, studioId: string, scenario: Scenario, model: string | undefined): Promise<Run> {
  const suffix = randomUUID().slice(0, 8);
  const spaceType = scenario.space ?? 'canvas';
  const project = await createProject(api, { studioId, name: `cocreation ${scenario.id} ${suffix}`, slug: `cocreation-${scenario.id}-${suffix}`, spaceType });
  try {
    const space = { id: randomUUID(), name: spaceType === 'document' ? 'Chapter one' : 'Space 1', type: spaceType };
    // As the product sends them: a document's blocks each under its
    // `<!-- b:N -->` marker, an open canvas with its (here empty) content, a
    // Timeline or 3D Space as unreadable.
    const piece = (from: number, list: readonly (readonly [string, string])[]): string =>
      list.map(([, text], i) => `<!-- b:${String(from + i)} -->\n${text}`).join('\n\n');
    const docRead = scenario.doc === undefined ? undefined : (() => {
      const blocks = scenario.doc.map(([type, text], i) => ({ id: `b${String(i + 1)}`, type, text, lossy: false, partial: false }));
      const content = piece(1, scenario.doc);
      return { content, total_chars: content.length, blocks };
    })();
    const readable = spaceType === 'canvas' || spaceType === 'document';
    const canvasDetail = { selected_total: 0, selected_attached: 0, selected_whole: 0, slim: false, texts_cut: 0, names_only: 0, edges_not_listed: 0, nodes_not_listed: 0, groups_not_listed: 0 };
    const extra: Record<string, unknown> = { spaces: [{ id: space.id, name: space.name, kind: space.type }] };
    if (docRead !== undefined) extra.current_space = { id: space.id, name: space.name, kind: 'document', state: 'loaded', ...docRead };
    else if (spaceType === 'canvas') extra.current_space = { id: space.id, name: space.name, kind: 'canvas', state: 'loaded', content: '', total_chars: 0, detail: canvasDetail };
    else extra.current_space = { id: space.id, name: space.name, kind: space.type, state: 'unreadable' };
    const conversation = await dataOf<{ id: string }>(
      await api.post('/api/v1/chat/conversations', { headers: { 'Idempotency-Key': randomUUID() }, data: { project_id: project.id } }),
      'create conversation',
    );
    const base = { project_id: project.id, conversation_id: conversation.id, time_zone: TIME_ZONES[scenario.lang] ?? 'UTC', ...extra, ...(model === undefined ? {} : { model }) };
    const chips = (scenario.chips ?? []).map((chip) => ({ id: chip.id, type: 'image', name: chip.name, data_snapshot: { url: chip.url } }));
    await send(api, scenario, { ...base, message: scenario.text, attached_chips: chips });
    const answered = new Map<string, string>();
    for (let card = 0; card < FOLLOW_UPS; card += 1) {
      const pending = (await partsOf(api, conversation.id)).filter(
        (part) => (part.status ?? part.state) === 'input-available' && ['ask_user', 'request_space_content'].includes(toolOf(part) ?? ''),
      ).at(-1);
      if (pending === undefined) break;
      if (toolOf(pending) === 'ask_user') {
        const questions: CardQuestion[] = (pending.input?.questions ?? []).map((q) => ({
          question: q.question ?? '',
          options: (q.options ?? []).map((option) => (typeof option === 'string' ? option : option.label ?? '')),
        }));
        const fixed = scenario.fixed?.[card];
        const answers: CardAnswer[] = fixed !== undefined ? fixedAnswers(fixed, questions) : parseUserAnswers(await askHelper(helper, simulatedUserPrompt(scenario, questions)), questions);
        answered.set(pending.toolCallId ?? '', JSON.stringify(answers));
        await send(api, scenario, { ...base, message: '', answer: { toolCallId: pending.toolCallId, answers } });
      } else {
        // A part asked for comes back named and cut to that part, as the browser sends it.
        const asked = pending.input?.spaces?.find((one) => one.id === space.id);
        const range = asked?.blocks;
        const docPart = range === undefined || scenario.doc === undefined ? undefined : piece(range.from, scenario.doc.slice(range.from - 1, range.to));
        const content = docPart ?? docRead?.content ?? scenario.spaceContent ?? '';
        const part = range !== undefined
          ? { part: { blocks: range }, blocks_total: scenario.doc?.length ?? 0 }
          : asked?.node_ids !== undefined
            ? { part: { node_ids: asked.node_ids }, nodes_missing: asked.node_ids.length }
            : {};
        answered.set(pending.toolCallId ?? '', readable ? `shared the Space: ${content}` : 'shared the Space, which cannot be read');
        const shared = readable
          ? { id: space.id, name: space.name, kind: space.type, state: 'read', content, total_chars: content.length, ...(space.type === 'canvas' ? { detail: canvasDetail } : {}), ...part }
          : { id: space.id, name: space.name, kind: space.type, state: 'unreadable', ...('part' in part ? { part: part.part } : {}) };
        await send(api, scenario, { ...base, message: '', shared_spaces: { toolCallId: pending.toolCallId, decision: 'shared', spaces: [shared] } });
      }
    }
    const steps: RunStep[] = (await partsOf(api, conversation.id)).flatMap((part): RunStep[] => {
      const tool = toolOf(part);
      if (tool === undefined) return part.type === 'text' ? [{ kind: 'text', text: part.text ?? '' }] : [];
      const call: RunStep = { kind: 'call', tool, state: part.status ?? part.state ?? '', input: part.input };
      const answer = answered.get(part.toolCallId ?? '');
      return answer === undefined ? [call] : [call, { kind: 'answer', text: answer }];
    });
    return { steps };
  } finally {
    await api.post(`/api/v1/projects/${project.id}/archive`);
  }
}

/**
 * Every part of the agent's messages in a conversation, in order.
 * @param api - The signed-in request context.
 * @param conversationId - The conversation.
 * @returns The parts.
 */
async function partsOf(api: APIRequestContext, conversationId: string): Promise<StoredPart[]> {
  const read = await dataOf<{ messages?: { role?: string; parts?: StoredPart[] }[] }>(await api.get(`/api/v1/chat/conversations/${conversationId}`), 'read conversation');
  return (read.messages ?? []).filter((m) => m.role === 'assistant').flatMap((m) => m.parts ?? []);
}

/**
 * The judge's verdict on a run.
 * @param helper - A request context for the helper model.
 * @param scenario - The scenario.
 * @param run - The run.
 * @returns The verdict.
 * @throws {Error} When the judge's answer holds no verdict.
 */
async function judge(helper: APIRequestContext, scenario: Scenario, run: Run): Promise<Verdict> {
  return parseVerdict(await askHelper(helper, judgePrompt(scenario, run), true));
}

/**
 * Run jobs a few at a time.
 * @param jobs - The jobs.
 * @param atOnce - How many run together.
 * @returns Each job's result, in order.
 */
async function pooled<T>(jobs: readonly (() => Promise<T>)[], atOnce: number): Promise<T[]> {
  const results: T[] = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(atOnce, jobs.length) }, async () => {
      for (let at = next++; at < jobs.length; at = next++) results[at] = await (jobs[at] as () => Promise<T>)();
    }),
  );
  return results;
}

/**
 * Every scenario on one model, judged, with the rows that missed four in five.
 * @param label - The model's name in the report.
 * @param model - The model, or undefined for the default.
 * @param scenarios - The scenarios to run.
 * @param baseURL - Where the app under test is served.
 * @returns The rows that did not pass.
 */
/**
 * A short fingerprint of a scenario's criterion, kept with every run and label
 * so a label made against older words is found.
 * @param scenario - The scenario.
 * @returns The first twelve hex digits of the criterion's SHA-256.
 */
function criterionOf(scenario: Scenario): string {
  return createHash('sha256').update(scenario.pass).digest('hex').slice(0, 12);
}

async function evaluate(label: string, model: string | undefined, scenarios: readonly Scenario[], baseURL: string | undefined): Promise<string[]> {
  // Both of the slot's accounts take turns, so the per-account limits on
  // creating Projects and conversations are reached half as fast.
  const accounts = await Promise.all(
    (['A', 'B'] as const).map(async (account) => {
      const api = await request.newContext({ baseURL, storageState: stateFile(account) });
      const studios = await dataOf<{ id: string; type: string }[]>(await api.get('/api/v1/studios'), 'list studios');
      return { api, studioId: studios.find((one) => one.type === 'personal')?.id ?? '' };
    }),
  );
  const helper = await request.newContext();
  try {
    const jobs = scenarios.flatMap((scenario, row) =>
      Array.from({ length: RUNS }, (_, index) => async () => {
        const { api, studioId } = accounts[(row * RUNS + index) % accounts.length] as (typeof accounts)[number];
        try {
          const run = await runOnce(api, helper, studioId, scenario, model);
          return { scenario: scenario.id, criterion: criterionOf(scenario), index, run, verdict: await judge(helper, scenario, run) };
        } catch (err) {
          return { scenario: scenario.id, criterion: criterionOf(scenario), index, error: String(err), verdict: { pass: false, reason: 'errored' } };
        }
      }),
    );
    const results = await pooled(jobs, AT_ONCE);
    const out = test.info().outputPath(`agent-cocreation-${label}.json`);
    mkdirSync(test.info().outputDir, { recursive: true });
    writeFileSync(out, JSON.stringify(results, null, 2));
    // A run that errored (a helper, the stack, the request) was never judged;
    // it counts on its own line, outside the pass rate.
    const judged = results.filter((one) => !('error' in one));
    const passed = judged.filter((one) => one.verdict.pass).length;
    const { low, high } = judged.length > 0 ? wilson(passed, judged.length) : { low: 0, high: 0 };
    const failing: string[] = [];
    const lines = scenarios.map((scenario) => {
      const row = judged.filter((one) => one.scenario === scenario.id);
      const errored = results.filter((one) => one.scenario === scenario.id && 'error' in one);
      const ok = row.filter((one) => one.verdict.pass).length;
      if (row.length === 0 || !rowPasses(ok, row.length)) failing.push(scenario.id);
      const misses = [
        ...row.filter((one) => !one.verdict.pass).map((one) => `#${String(one.index + 1)} ${one.verdict.reason}`),
        ...errored.map((one) => `#${String(one.index + 1)} errored, not judged: ${'error' in one ? one.error : ''}`),
      ];
      return `${scenario.id}: ${String(ok)}/${String(row.length)}${errored.length > 0 ? ` (${String(errored.length)} errored)` : ''}${misses.length > 0 ? `\n    ${misses.join('\n    ')}` : ''}`;
    });
    const percent = (x: number): string => `${(x * 100).toFixed(1)}%`;
    const erroredAll = results.length - judged.length;
    console.warn(`${label}: ${String(passed)}/${String(judged.length)} passed (95% ${percent(low)}–${percent(high)})${erroredAll > 0 ? `, ${String(erroredAll)} errored` : ''}; runs in ${out}\n${lines.join('\n')}`);
    return failing;
  } finally {
    for (const { api } of accounts) await api.dispose();
    await helper.dispose();
  }
}

test('the default model co-creates as the scenarios say @needs-model @needs-internet', async ({ baseURL }) => {
  test.setTimeout(4 * 60 * 60_000);
  expect(await evaluate('default', DEFAULT_MODEL, SCENARIOS, baseURL)).toEqual([]);
});

test('the comparison model co-creates as the scenarios say @needs-model @needs-internet', async ({ baseURL }) => {
  test.setTimeout(4 * 60 * 60_000);
  const compared = SCENARIOS.filter((one) => one.compare === true);
  expect(await evaluate('compare', COMPARE_MODEL, compared, baseURL)).toEqual([]);
});

test('the judge agrees with hand labels @needs-model @needs-internet', async () => {
  test.setTimeout(60 * 60_000);
  const byId = new Map(SCENARIOS.map((one) => [one.id, one]));
  const labelled = readFileSync(LABELS, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { scenario: string; criterion: string; run: Run; human: boolean })
    .filter((one) => byId.has(one.scenario));
  // A label made against a criterion since rewritten judges other words.
  const stale = labelled.filter((one) => one.criterion !== criterionOf(byId.get(one.scenario) as Scenario)).map((one) => one.scenario);
  expect([...new Set(stale)], 'labels made against an older criterion').toEqual([]);
  expect(labelled.length, 'labels for the scenarios run').toBeGreaterThan(0);
  const helper = await request.newContext();
  try {
    const judged = await pooled(
      labelled.map((one) => async () => {
        const verdict = await judge(helper, byId.get(one.scenario) as Scenario, one.run);
        return { scenario: one.scenario, human: one.human, judge: verdict.pass, reason: verdict.reason };
      }),
      AT_ONCE,
    );
    mkdirSync(test.info().outputDir, { recursive: true });
    writeFileSync(test.info().outputPath('agent-cocreation-judge.json'), JSON.stringify(judged, null, 2));
    const share = (x: number | undefined): string => (x === undefined ? '-' : `${(x * 100).toFixed(0)}%`);
    const rows = [...agreementByScenario(judged)].map(
      ([scenario, one]) => `${scenario}: passes ${share(one.truePass)} of ${String(one.passes)}, fails ${share(one.trueFail)} of ${String(one.fails)}`,
    );
    const said = agreement(judged);
    console.warn(`judge against hand labels: passes ${share(said.truePass)} of ${String(said.passes)}, fails ${share(said.trueFail)} of ${String(said.fails)}\n${rows.join('\n')}`);
    // A side with no labels has nothing to agree with.
    if (said.truePass !== undefined) expect(said.truePass).toBeGreaterThanOrEqual(0.9);
    if (said.trueFail !== undefined) expect(said.trueFail).toBeGreaterThanOrEqual(0.9);
  } finally {
    await helper.dispose();
  }
});
