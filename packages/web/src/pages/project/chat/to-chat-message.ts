// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One message, from what the protocol carries to what the panel draws.
 *
 * The panel wants prose as one string, thinking as another, and tool calls as
 * a list; the protocol carries parts in the order they happened. Reading the
 * parts out is this function's whole job, and it happens here rather than in
 * the bubble because two of the three are joins across several parts —
 * something a component would have to redo on every render.
 *
 * The store used to send these three already flattened, alongside the parts
 * they came from. They are worked out here now: a second copy on the wire is
 * one the client has to keep in step with the first.
 */
import { getToolName, isToolUIPart } from 'ai';
import type { UIMessage } from 'ai';
import type { z } from 'zod';
import {
  canvasProposalSchema,
  chipOfPart,
  documentProposalSchema,
  FAILURE_LINES,
  isReaderLine,
  LEGACY_FAILURE_LINES,
  NEVER_RAN,
  readQuestionnaire,
  stripDsml,
  TURNED_AWAY,
} from '@breatic/shared';
import type { CanvasProposal, ChatAttachedChip, DocumentProposal } from '@breatic/shared';
import type { ChatAsset, ChatFailureLine, ChatMessage, ChatQuestionnaire, ChatSource, ToolCall } from '@web/pages/project/chat/types';
import { failurePlaceholder, PLACEHOLDER_MARK } from '@web/pages/project/chat/tool-failure-plugin';

/** The part type carrying a turn that was stopped. */
const INTERRUPTED = 'data-interrupted';

/** The part type carrying a turn that could not be finished. */
const FAILED = 'data-failed';

/** The part type carrying a turn the output ceiling cut off. */
const TRUNCATED = 'data-truncated';

/** The mark a reply stored before inner#1542 carries when it stopped to ask. */
const BLOCKED = 'data-blocked';

/** The mark naming the questionnaire a turn stopped at (inner#1542). */
const ASK_AWAITING = 'data-ask-awaiting';

/** The tool that puts a questionnaire to the reader. */
const ASK_TOOL = 'ask_user';

/** How long the turn thought, as the wire names it. */
const THINKING_TIME = 'data-thinking-time';

/** The tool whose results the source row and the citation chips are built from. */
const SEARCH_TOOL = 'web_search';

/** The tool that finds pictures and puts them in front of the reader. */
const RESULTS_TOOL = 'search_images';

/** The tool that proposes a group of canvas nodes for the reader to place. */
const PROPOSE_TOOL = 'propose_canvas_action';

/** The tool that proposes a comment, rewrite or insert for the open document. */
const PROPOSE_DOCUMENT_TOOL = 'propose_document_edit';

/**
 * The proposal one finished `propose_canvas_action` or `propose_document_edit`
 * call carries, if any.
 *
 * Read defensively, like the pictures above: a refused proposal answers with a
 * reason instead of a proposal, and a row stored before the tool existed
 * carries the model's own text -- neither is a proposal at all. One the tool
 * accepted is checked against the shape this build places or lands
 * (inner#1499): a canvas group stored before that shape changed would throw
 * half way onto the canvas, so it is told apart as expired rather than
 * offered as a card.
 * @param output - Whatever the call answered with.
 * @param schema - The shape this build reads that tool's proposal in.
 * @returns The proposal, `'expired'` for an accepted one this build cannot
 *   use, or null when the call carries none.
 */
function placedOf<T>(output: unknown, schema: z.ZodType<T>): T | 'expired' | null {
  // Null only, because indexing it is what throws.
  if (output === null || output === undefined) return null;
  if ((output as Record<string, unknown>)['placed'] !== true) return null;
  const parsed = schema.safeParse(output);
  return parsed.success ? parsed.data : 'expired';
}

/**
 * The pictures one finished `search_images` call carries.
 *
 * Read defensively. A row stored before this tool existed carries the model's
 * own text, and a call that failed carries nothing at all -- reading a field
 * off either throws while a message is being built, which takes the whole
 * conversation down rather than one row of squares.
 * @param output - Whatever the call answered with.
 * @returns The pictures, in the order the search ranked them.
 */
function assetsOf(output: unknown): ChatAsset[] {
  if (output === null || typeof output !== 'object') return [];
  const list = (output as Record<string, unknown>)['images'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): ChatAsset[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const { thumbnailUrl, imageUrl, pageUrl, title } = entry as Record<string, unknown>;
    // The square is drawn from the thumbnail and nothing else, so that is the
    // one field an entry cannot do without.
    if (typeof thumbnailUrl !== 'string' || thumbnailUrl === '') return [];
    return [
      {
        thumbnailUrl,
        ...(typeof imageUrl === 'string' ? { imageUrl } : {}),
        ...(typeof pageUrl === 'string' ? { pageUrl } : {}),
        title: typeof title === 'string' ? title : '',
      },
    ];
  });
}

/**
 * The pages one finished search returned, or nothing.
 *
 * A result gets here in three shapes and only one of them holds sources: what
 * the tool answers with today, the model's own text on a row stored before
 * that, and nothing at all on a call that failed. Reading `sources` off the
 * middle one yields undefined, and a row built from that is a row of blanks.
 * @param output - Whatever the call answered with.
 * @returns The sources, or an empty list when there are none to read.
 */
function sourcesOf(output: unknown): Array<[number, ChatSource]> {
  if (output === null || typeof output !== 'object') return [];
  const found = (output as { sources?: unknown }).sources;
  if (!Array.isArray(found)) return [];
  return found.flatMap((entry): Array<[number, ChatSource]> => {
    if (entry === null || typeof entry !== 'object') return [];
    const { url, title, publisher, index } = entry as Record<string, unknown>;
    if (typeof url !== 'string' || url === '' || typeof title !== 'string') return [];
    if (typeof publisher !== 'string' || typeof index !== 'number') return [];
    return [[index, { url, title, publisher, indexes: [index] }]];
  });
}

/**
 * The sentence key a tool declared for while it runs, if it declared one.
 *
 * Declared in the SDK's `metadata` and carried onto the part as
 * `toolMetadata`. Read defensively: it is the tool's own word, typed as free
 * JSON, and a replayed call has no metadata at all.
 * @param part - The tool part.
 * @returns The key in a spreadable object, or an empty one.
 */
function runningLineOf(part: unknown): { runningLine?: string } {
  const metadata = (part as { toolMetadata?: unknown }).toolMetadata;
  if (metadata === null || typeof metadata !== 'object') return {};
  const line = (metadata as { runningLine?: unknown }).runningLine;
  return typeof line === 'string' ? { runningLine: line } : {};
}

/**
 * The step each tool's failure line names (inner#1620). Spelled out so the
 * guide's coverage check can read every key; a tool not listed is named by
 * its own name.
 */
const STEP_KEYS: Readonly<Record<string, string>> = {
  web_search: 'chat.tool.step.webSearch',
  search_images: 'chat.tool.step.searchImages',
  understand_media: 'chat.tool.step.understandMedia',
  save_image: 'chat.tool.step.saveImage',
  judge_likelihood: 'chat.tool.step.judge',
  propose_canvas_action: 'chat.tool.step.proposeCanvas',
  propose_document_edit: 'chat.tool.step.proposeDocument',
  list_generation_models: 'chat.tool.step.listModels',
  get_canvas_capabilities: 'chat.tool.step.canvasCapabilities',
  get_product_guide: 'chat.tool.step.productGuide',
};

/** The tools whose step names what was searched for. */
const QUERIED = new Set([SEARCH_TOOL, RESULTS_TOOL]);

/** The causes rows stored before inner#1620 carry, which name no cause. */
const LEGACY = new Set<string>(Object.values(LEGACY_FAILURE_LINES));

/**
 * The line a tool part that ended in an error is drawn with, or null when it
 * draws none: a call stopped, turned away, or that never ran -- the turn's
 * own ending line says what happened to those.
 * @param part - The tool part.
 * @param part.state - Where it stands.
 * @param part.input - What the model sent.
 * @param name - The tool's name.
 * @returns The line, or null.
 */
function failureLineOf(part: { state: string; input?: unknown }, name: string): ChatFailureLine | null {
  if (part.state !== 'output-error') return null;
  const errorText = (part as { errorText?: unknown }).errorText;
  const kind = (part as { failureKind?: unknown }).failureKind;
  if (errorText === TURNED_AWAY || errorText === NEVER_RAN || errorText === FAILURE_LINES.stopped) return null;
  if (kind === 'turned_away' || kind === 'never_ran' || kind === 'user_aborted') return null;
  const query = (part.input as { query?: unknown } | undefined)?.query;
  const stepKey = STEP_KEYS[name];
  const step: ChatFailureLine['step'] =
    stepKey === undefined
      ? { key: 'chat.tool.step.other', params: { tool: name } }
      : QUERIED.has(name)
        ? { key: stepKey, params: { query: typeof query === 'string' ? query : '' } }
        : { key: stepKey };
  // The key vouches for itself: it is either one of ours or it is not, and
  // the table is what answers that. The same field carries the SDK's own
  // fixed English sentence when it has nothing else to put there, which is
  // never put on the screen.
  const reason = isReaderLine(errorText) ? (LEGACY.has(errorText) ? null : errorText) : FAILURE_LINES.ourFault;
  return { step, reason, count: 1 };
}

/**
 * Whether two failure lines read the same: the same step, what it was given,
 * and the same cause.
 * @param a - One line.
 * @param b - The other.
 * @returns True when they read the same.
 */
function sameLine(a: ChatFailureLine, b: ChatFailureLine): boolean {
  return a.step.key === b.step.key && a.reason === b.reason && JSON.stringify(a.step.params) === JSON.stringify(b.step.params);
}

/**
 * Whether a markdown document ends inside a fenced code block.
 * @param markdown - The document so far.
 * @returns True when a fence is open.
 */
function fenceOpen(markdown: string): boolean {
  // A backtick fence's info string carries no backtick (CommonMark), so ```x``` on one line is inline code.
  return (markdown.match(/^ {0,3}(?:`{3,}(?![^`\n]*`)|~{3,})/gm) ?? []).length % 2 === 1;
}

/**
 * How far a tool got, in the panel's words.
 * @param state - The tool part's state, as the SDK reports it.
 * @param stillRunning - Whether the turn that made this call is still going.
 * @returns Our word for the same thing.
 */
function statusOf(state: string, stillRunning: boolean): ToolCall['status'] {
  if (state === 'output-available') return 'success';
  if (state === 'output-error' || state === 'output-denied') return 'error';
  // Not finished, and nothing is coming: a turn stopped locally leaves its
  // calls exactly where they were -- the SDK does not push them to any end
  // state -- so a card left on `pending` here spins until the page is
  // reloaded. The server settles the same thing before it stores a turn
  // (`main-agent.ts`, "nothing in a stored record may still say it is
  // running"); this is that same reading, one moment earlier.
  return stillRunning ? 'pending' : 'error';
}

/**
 * The call a mark names as the card the reader is shown, for each mark.
 * @param parts - The message's parts.
 * @returns The named call ids, in order.
 */
function awaitedCalls(parts: UIMessage['parts']): Set<string> {
  const named = new Set<string>();
  for (const part of parts) {
    if (part.type !== ASK_AWAITING) continue;
    const id = (part as { data?: { toolCallId?: unknown } }).data?.toolCallId;
    if (typeof id === 'string') named.add(id);
  }
  return named;
}

/**
 * The questionnaire one `ask_user` part carries, with where it stands, or
 * null when it carries none to draw: a call still arriving, one turned away,
 * or one stored before the card existed.
 * @param part - The tool part.
 * @param part.toolCallId - Its call.
 * @param part.state - Where it stands.
 * @param part.input - What the model sent.
 * @param part.output - What it ended with, once it has.
 * @param awaited - The calls named as the card the reader is shown.
 * @returns The questionnaire, or null.
 */
function questionnaireOf(
  part: { toolCallId: string; state: string; input?: unknown; output?: unknown },
  awaited: ReadonlySet<string>,
): ChatQuestionnaire | null {
  const asked = readQuestionnaire(part.input);
  if (asked === null) return null;
  const base = { toolCallId: part.toolCallId, questions: asked.questions };
  if (part.state === 'output-available') {
    const output = part.output as { answers?: unknown; repliedInChat?: unknown } | null | undefined;
    if (output?.repliedInChat === true) return { ...base, state: 'replied' };
    if (Array.isArray(output?.answers)) {
      return { ...base, state: 'answered', answers: output.answers as ChatQuestionnaire['answers'] };
    }
    return null;
  }
  return part.state === 'input-available' && awaited.has(part.toolCallId) ? { ...base, state: 'awaiting' } : null;
}

/**
 * A reply as the panel lays it out: whole, or split where each segment that
 * asked a questionnaire ended, once the reader answered on the card and the
 * turn went on in the same message (inner#1542).
 *
 * The server stores the two segments as two rows, so a reload reads them as
 * two messages; splitting the live one the same way keeps the card above what
 * the turn said after it, with or without a reload in between.
 * @param message - The message as the conversation holds it.
 * @param options - What is true of the message right now.
 * @param options.open - The turn is still writing it: a card answered last
 *   in it opens an empty part below, where what the turn says next arrives
 *   and the wait for it is drawn.
 * @returns It, or its parts, split after each card answered in it; each part
 *   after the first named after the call it follows.
 */
export function splitAtAnswer(message: UIMessage, { open = false }: { open?: boolean } = {}): UIMessage[] {
  const views: UIMessage[] = [];
  let from = 0;
  let id = message.id;
  for (const [at, part] of message.parts.entries()) {
    if (part.type !== ASK_AWAITING || (!open && at === message.parts.length - 1)) continue;
    const callId = (part as { data?: { toolCallId?: unknown } }).data?.toolCallId;
    const answered = message.parts.some(
      (p) => isToolUIPart(p) && p.toolCallId === callId && p.state === 'output-available',
    );
    if (!answered || typeof callId !== 'string') continue;
    views.push({ ...message, id, parts: message.parts.slice(from, at + 1) });
    from = at + 1;
    id = `${message.id}~${callId}`;
  }
  if (from === 0) return [message];
  return [...views, { ...message, id, parts: message.parts.slice(from) }];
}

/**
 * Adapt one message into what the panel renders.
 * @param message - The message as the conversation holds it.
 * @param options - What is true of this message right now rather than of the
 *   message itself.
 * @param options.streaming - Its bubble is still receiving tokens.
 * @param options.failedJustNow - This failure is happening with the reader
 *   waiting on it, rather than being read back out of the history.
 * @returns The same message in the panel's shape.
 */
export function toChatMessage(
  message: UIMessage,
  options: { streaming?: boolean; failedJustNow?: boolean } = {},
): ChatMessage {
  let content = '';
  // The prose with each failure line's place held (inner#1620). Failures
  // since the last prose wait in `open`, so one the same tool recovered from
  // before the reply went on is dropped; ones placed inside an open code
  // fence wait in `deferred` until it closes.
  let body = '';
  const failureLines: ChatFailureLine[] = [];
  let open: Array<{ tool: string; line: ChatFailureLine }> = [];
  const deferred: number[] = [];
  /**
   * Put the lines waiting on an open code fence once it has closed.
   * @param force - Put them even inside an open fence: the reply has ended.
   */
  const placeDeferred = (force = false): void => {
    if (!force && fenceOpen(body)) return;
    for (const index of deferred.splice(0)) body += `${body === '' ? '' : '\n\n'}${failurePlaceholder(index)}`;
  };
  /** Place the failures since the last prose, the same line twice in a row once. */
  const placeOpen = (): void => {
    for (const { line } of open) {
      const last = failureLines.at(-1);
      const joined = deferred.length > 0 || body.endsWith(PLACEHOLDER_MARK);
      if (joined && last !== undefined && sameLine(last, line)) {
        last.count += 1;
        continue;
      }
      failureLines.push(line);
      deferred.push(failureLines.length - 1);
    }
    open = [];
    placeDeferred();
  };
  let thinking = '';
  const toolCalls: ToolCall[] = [];
  let interrupted = false;
  let truncated = false;
  let failed = false;
  let blocked = false;
  let thinkingMs: number | undefined;
  let thinkingNow = false;
  // Two readings of the same searches. The list shows each page once; the
  // markers in the prose resolve against the sequence the model was shown,
  // which counts a page found twice as two. Both readings are worked out
  // after the loop, from the numbers and pages collected here in the order
  // the searches handed them over.
  const found: Array<[number, ChatSource]> = [];
  const assets: ChatAsset[] = [];
  const proposals: CanvasProposal[] = [];
  const documentProposals: DocumentProposal[] = [];
  const questionnaires: ChatQuestionnaire[] = [];
  // Read before the loop, because the mark comes after the call it names.
  const awaited = awaitedCalls(message.parts);
  let hasExpiredProposal = false;
  const attachments: ChatAttachedChip[] = [];
  // The server writes it onto the stored message; a message this reader has
  // only just sent is not stored yet and carries none.
  const written = (message.metadata as { ts?: unknown } | undefined)?.ts;
  const sentAt = typeof written === 'string' ? written : undefined;

  // Read before the loop because a tool part can come before the mark. A call
  // this turn cut short has nothing on it saying so — the SDK client leaves it
  // exactly where it was — and this mark is the only answer to who stopped it.
  const wasStopped = message.parts.some((p) => p.type === INTERRUPTED);

  for (const part of message.parts) {
    if (isToolUIPart(part)) {
      const isAsk = getToolName(part) === ASK_TOOL;
      // A card waiting for the reader is not a call that came to nothing; a
      // second card in the step, which the server named nothing for, was
      // turned away rather than failed.
      const waiting = isAsk && part.state === 'input-available' && awaited.has(part.toolCallId);
      const turnedAwayAsk = isAsk && part.state === 'input-available' && awaited.size > 0 && !waiting;
      const status = waiting ? 'pending' : statusOf(part.state, options.streaming === true);
      // Cut short rather than failed: it never reached an end state of its
      // own, and the turn it belonged to was stopped.
      const cutShort =
        status === 'error' && wasStopped && part.state !== 'output-error'
          ? ({ failureKind: 'user_aborted' } as const)
          : {};
      toolCalls.push({
        id: part.toolCallId,
        name: getToolName(part),
        args: (part.input ?? {}) as ToolCall['args'],
        status,
        ...(status === 'success' ? { result: part.output as string } : {}),
        ...cutShort,
        // Turned away to steer the model: the wire's one error field says so
        // while the turn runs, and a replayed part says so in its kind below.
        ...((status === 'error' && 'errorText' in part && part.errorText === TURNED_AWAY) || turnedAwayAsk
          ? ({ failureKind: 'turned_away' } as const)
          : {}),
        // Declared by the tool, carried by the SDK. Read off whatever the
        // part has: a replayed call has no metadata at all, and the line it
        // would name is not drawn on one anyway.
        ...runningLineOf(part),
        // What the message itself says the ending was. A replayed one always
        // carries it; a live one never does -- the wire has a single field for
        // a failure and it is carrying the line. The live answer is the one
        // worked out above, and it is left alone here: this spread only fires
        // when the field is present, which on a live message it is not.
        ...(status === 'error' && 'failureKind' in part
          ? { failureKind: (part as { failureKind: ToolCall['failureKind'] }).failureKind }
          : {}),
      });
      const name = getToolName(part);
      if (status === 'success') open = open.filter((failure) => failure.tool !== name);
      const failureLine = failureLineOf(part, name);
      if (failureLine !== null) open.push({ tool: name, line: failureLine });
      if (status === 'success' && getToolName(part) === RESULTS_TOOL) {
        assets.push(...assetsOf(part.output));
      }
      if (status === 'success' && getToolName(part) === PROPOSE_TOOL) {
        const proposal = placedOf(part.output, canvasProposalSchema);
        if (proposal === 'expired') hasExpiredProposal = true;
        else if (proposal !== null) proposals.push(proposal);
      }
      if (status === 'success' && getToolName(part) === PROPOSE_DOCUMENT_TOOL) {
        const proposal = placedOf(part.output, documentProposalSchema);
        if (proposal === 'expired') hasExpiredProposal = true;
        else if (proposal !== null) documentProposals.push(proposal);
      }
      if (status === 'success' && getToolName(part) === SEARCH_TOOL) {
        found.push(...sourcesOf(part.output));
      }
      if (isAsk) {
        const questionnaire = questionnaireOf(part, awaited);
        if (questionnaire !== null) questionnaires.push(questionnaire);
      }
      continue;
    }
    const chip = chipOfPart(part);
    if (chip) {
      attachments.push(chip);
      continue;
    }
    if (part.type === 'text') {
      const words = stripDsml(part.text);
      content += words;
      placeOpen();
      const prose = words.replaceAll(PLACEHOLDER_MARK, '');
      body += body.endsWith(PLACEHOLDER_MARK) ? `\n\n${prose}` : prose;
      placeDeferred();
    }
    else if (part.type === 'reasoning') {
      thinking += part.text;
      // The thinking says whether it is still going; the turn does not. How
      // long it took is only sent when the turn ends, so reading that instead
      // leaves this line saying "thinking" through the whole answer.
      thinkingNow = (part as { state?: unknown }).state === 'streaming';
    }
    else if (part.type === INTERRUPTED) interrupted = true;
    else if (part.type === FAILED) failed = true;
    else if (part.type === TRUNCATED) truncated = true;
    else if (part.type === BLOCKED) blocked = true;
    else if (part.type === THINKING_TIME) {
      const ms = (part as { data?: { ms?: unknown } }).data?.ms;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) thinkingMs = ms;
    }
  }

  placeOpen();
  placeDeferred(true);

  // A page found by two searches was handed two numbers, and the prose can
  // carry either: one line answers to both, and both numbers resolve to that
  // line. Rebuilt rather than pushed to as the loop goes, so no line is ever
  // handed out before it knows every number it answers to.
  const byUrl = new Map<string, ChatSource>();
  for (const [index, source] of found) {
    const kept = byUrl.get(source.url);
    byUrl.set(
      source.url,
      kept === undefined ? source : { ...kept, indexes: [...kept.indexes, index] },
    );
  }
  // By number rather than by when the page turned up: two searches in one
  // step take their numbers when their answers arrive, and the parts arrive
  // in the order the model asked. Reading down the list follows the numbers
  // in the prose.
  const sources = [...byUrl.values()].sort((a, b) => (a.indexes[0] ?? 0) - (b.indexes[0] ?? 0));
  const citations: Record<number, ChatSource> = {};
  for (const line of sources) for (const n of line.indexes) citations[n] = line;

  return {
    id: message.id,
    // A stored role is only ever one of these two; the panel's third is for
    // messages it makes up itself, which none of these are.
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
    ...(failureLines.length > 0 ? { body, failureLines } : {}),
    ...(sentAt === undefined ? {} : { sentAt }),
    ...(thinking !== '' ? { thinking } : {}),
    ...(thinkingMs === undefined ? {} : { thinkingMs }),
    ...(thinkingNow ? { thinkingNow: true as const } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(interrupted ? { interrupted: true as const } : {}),
    ...(failed ? { failed: true } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    ...(blocked ? { blocked: true as const } : {}),
    ...(sources.length > 0 ? { sources, citations } : {}),
    ...(assets.length > 0 ? { assets } : {}),
    ...(proposals.length > 0 ? { proposals } : {}),
    ...(documentProposals.length > 0 ? { documentProposals } : {}),
    ...(questionnaires.length > 0 ? { questionnaires } : {}),
    ...(hasExpiredProposal ? { hasExpiredProposal: true as const } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(options.failedJustNow === true ? { failedJustNow: true as const } : {}),
    ...(options.streaming === true ? { streaming: true } : {}),
  };
}
