// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Chat panel message model — mirrored from the Agent message contract.
 * Lives next to the panel components so the UI layer has a stable type
 * regardless of the backend wire schema (data/api/chat.ts adapts).
 */

import type { AskUserAnswer, AskUserQuestion, CanvasProposal, ChatAttachedChip, DocumentProposal, ToolFailureKind } from '@breatic/shared';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  /**
   * What the model sent this call.
   *
   * A string when the arguments would not parse as JSON: the call is refused
   * before it runs and what arrived is kept as it was, which is the only form
   * of it there is.
   */
  args: Record<string, unknown> | string;
  result?: unknown;
  /** How far this use of the tool got, as the store recorded it. */
  status: 'pending' | 'success' | 'error';
  /**
   * Which of the three endings left it without a result.
   *
   * A failure, a turn the user stopped and a call turned away all come over
   * as `error`, and they are shown differently. While a turn is still
   * streaming the SDK's client assembles those parts itself, so only a call
   * turned away is told apart, by the marker the server puts in its error
   * text; anything else is a failure there — a call the user stopped is left
   * `pending` there, not `error`.
   */
  failureKind?: ToolFailureKind;
  /**
   * The translation key for the sentence shown while this call runs.
   *
   * Declared by the tool, in the SDK's `metadata`, and carried here on the
   * part. A table of tool names in this package instead would be a second
   * list to keep true as tools are added, and the one they are declared in
   * belongs to a package the web build may not import.
   *
   * Absent on a tool that declares none, and on every replayed call: the
   * sentence only ever shows while a turn runs.
   */
  runningLine?: string;
}

/**
 * One page a turn's search found.
 *
 * The page's own text is not here. It goes to the model, which is what reads
 * it; the panel shows where a claim came from, and a wall of scraped prose
 * under an answer is not that.
 */
export interface ChatSource {
  /** Where the page is. Opened in a new tab when the chip is clicked. */
  url: string;
  /** What the page calls itself. The main line of a row in the box, and of the card. */
  title: string;
  /** Who published it. Shown in the card that floats on a marker, and nowhere else. */
  publisher: string;
  /**
   * Every number this page was handed in the turn.
   *
   * Decided when the search ran, so a `[N]` in the prose resolves to the page
   * the model meant however many searches the turn made.
   *
   * A turn that searches twice hands the same page a fresh number each time,
   * and the prose can carry either of them. The list at the foot is one line
   * per page, so that line has to answer to all of them -- a marker whose
   * number is nowhere in the list is a marker the list cannot be used to
   * follow up.
   */
  indexes: number[];
}

/**
 * One picture a turn found.
 *
 * Two addresses for the picture itself, and they are not interchangeable:
 * everything drawn on screen comes from the thumbnail, which the search
 * service proxies at 500px wide, and the original is where the site that
 * published it hosts the full-size file. A third address is the page it was
 * found on, which is neither of those.
 */
export interface ChatAsset {
  /** What every square and the open view are drawn from. */
  thumbnailUrl: string;
  /** The picture itself, for whoever wants the file rather than the view. */
  imageUrl?: string;
  /** The page it was found on. */
  pageUrl?: string;
  /** What to call it. */
  title: string;
}

/**
 * A questionnaire the agent put to the reader (inner#1542), with where it
 * stands: waiting for an answer, answered on the card, or replied to by a
 * message the reader wrote instead.
 */
export interface ChatQuestionnaire {
  /** The `ask_user` call that put it. */
  toolCallId: string;
  /** The questions, in the order the card numbers them. */
  questions: AskUserQuestion[];
  /** Where it stands. */
  state: 'awaiting' | 'answered' | 'replied';
  /** The answers given on the card, once it is answered there. */
  answers?: AskUserAnswer['answers'];
}

/** One tool step that did not finish, as its line says it (inner#1620). */
export interface ChatFailureLine {
  /** Which step, as a translation key and what it fills in. */
  step: { key: string; params?: Record<string, string> };
  /** The cause, as a translation key; null for a row stored before causes were recorded. */
  reason: string | null;
  /** How many times in a row the same line came. */
  count: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /**
   * What this message says, as text.
   *
   * Nothing sanitises it — the chat path has no such step anywhere, on either
   * side. It is safe today because it is drawn as text and never as markup.
   * Anyone about to render it as markup has to answer the two questions in
   * `packages/web/AGENTS.md#never-render-user-html` first, and the second one
   * is the trap: handing it
   * to a markdown renderer with raw HTML enabled counts.
   */
  content: string;
  /**
   * The prose with a placeholder where each failure line sits, for the
   * renderer alone (inner#1620). Absent when no step failed; `content` stays
   * what the reader copies.
   */
  body?: string;
  /** The tool steps that did not finish, in the order `body` places them. */
  failureLines?: ChatFailureLine[];
  /** What the reader attached to this message, in order. Absent when nothing. */
  attachments?: ChatAttachedChip[];
  /**
   * When the message was written down, as an absolute instant.
   *
   * The server's own clock, ISO-formatted, so the panel can say it in the
   * reader's day. A message this reader has only just sent has none until the
   * conversation comes back with it.
   */
  sentAt?: string;
  /** Optional hidden chain-of-thought, foldable in the UI. */
  thinking?: string;
  /** How long the turn thought, in milliseconds. Measured by the server. */
  thinkingMs?: number;
  /**
   * Whether the thinking itself is still going.
   *
   * Read off the reasoning rather than off the turn: how long it took is only
   * sent when the turn ends, so a line that watches the turn goes on saying
   * "thinking" through the whole answer.
   */
  thinkingNow?: boolean;
  toolCalls?: ToolCall[];
  /** Streaming = the bubble is still receiving tokens. */
  streaming?: boolean;
  /** The turn was stopped before it finished, so this is as far as it got. */
  interrupted?: true;
  /**
   * The turn failed and this reply is as much of it as there is.
   *
   * Stored, like {@link ChatMessage.interrupted}: the server records failure
   * as a part of the reply, so what is on screen while it happens and what a
   * reload brings back say the same thing.
   *
   * Only ever `true`; its absence is the ordinary case.
   */
  failed?: true;
  /**
   * The turn hit the per-call output ceiling, so this stops mid-sentence.
   *
   * Stored like {@link ChatMessage.interrupted}, and kept apart from it: what
   * ran out is room we set, not the reader's patience.
   *
   * Only ever `true`; its absence is the ordinary case.
   */
  truncated?: true;
  /**
   * The failure happened just now, with the reader waiting on this reply.
   *
   * It is the difference between living through a failure and reading about
   * one, and only the first is worth announcing — a reply that stops growing
   * and a stop button turning back into send are both purely visual, so
   * without this a screen reader user waits for an answer that is never
   * coming.
   *
   * Unlike {@link ChatMessage.failed} this is kept nowhere the message goes.
   * It belongs to the panel that watched it happen and is gone the moment
   * that panel is: not in the cache, which outlives the column being
   * collapsed, and not on the server, which would hand it back on reload.
   * Either would have a failure from ten minutes ago still announcing itself
   * as news.
   *
   * Only ever `true`; its absence is the ordinary case.
   */
  failedJustNow?: true;
  /**
   * The mark a reply stored before inner#1542 carries when it stopped to ask;
   * a turn waiting now is drawn by its questionnaire card.
   *
   * Only ever `true`; its absence is the ordinary case.
   */
  blocked?: true;
  /**
   * Every page this turn's searches found, each one once.
   *
   * Pooled across the turn's searches rather than grouped by search: a reader
   * scanning where an answer came from wants each publisher once, and only a
   * pooled list can drop the pages two searches both returned. Ordered by
   * first appearance.
   *
   * Absent, rather than empty, on a turn that searched for nothing.
   */
  sources?: ChatSource[];
  /**
   * What a `[N]` in the prose points at.
   *
   * Numbered the way the model was shown them -- one number per source per
   * search, duplicates kept -- because the model wrote its markers against
   * that sequence. {@link ChatMessage.sources} is the deduplicated list for
   * the row, and renumbering to match it would move every marker after the
   * first repeat.
   */
  citations?: Record<number, ChatSource>;
  /**
   * The pictures, clips and tracks this turn put in front of the reader.
   *
   * Absent, rather than empty, on a turn that found none.
   */
  assets?: ChatAsset[];
  /**
   * The groups of canvas nodes this turn proposed, in the order it proposed
   * them. Each draws a card the reader can press to place it.
   *
   * Rebuilt from the stored tool calls, so a card survives a reload exactly as
   * it was -- and carries no memory of having been pressed, because there is
   * nowhere for that to live and the message may be several turns old.
   */
  proposals?: CanvasProposal[];
  /**
   * The questionnaires this turn put to the reader, each drawn as a card.
   * Absent on a turn that asked nothing; a question stored before the card
   * existed is in the reply's words instead.
   */
  questionnaires?: ChatQuestionnaire[];
  /**
   * The document edits this turn proposed (inner#1509), each drawn as a card
   * the reader presses to land it. Rebuilt from the stored tool calls; whether
   * one already landed is read off the document.
   */
  documentProposals?: DocumentProposal[];
  /**
   * Whether this turn stored a proposal in a shape this build can no longer
   * place (inner#1499). The turn draws one line saying so, with nothing to
   * press, however many there were.
   */
  hasExpiredProposal?: true;
}
