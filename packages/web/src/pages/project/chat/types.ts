// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Chat panel message model — mirrored from the Agent message contract.
 * Lives next to the panel components so the UI layer has a stable type
 * regardless of the backend wire schema (data/api/chat.ts adapts).
 */

import type { ToolFailureKind } from '@breatic/shared';

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
   * Which of the two endings left it without a result.
   *
   * A failure and a turn the user stopped both come over as `error`, and they
   * are shown differently. Absent while a turn is still streaming: the SDK's
   * client assembles those parts itself and knows only that something went
   * wrong, which is a failure either way — a call the user stopped is left
   * `pending` there, not `error`.
   */
  failureKind?: ToolFailureKind;
  /**
   * The line to show, as a translation key.
   *
   * Never the reason itself. That names hosts, statuses and, for a refused
   * fetch, addresses inside the network; it goes to the model, which is what
   * acts on it, and the user learns what happened from the reply.
   */
  failureKey?: string;
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
  /** What the page calls itself. Shown in the card that floats on hover. */
  title: string;
  /** Who published it. This is what the row shows, not the host. */
  publisher: string;
  /**
   * The number the model was shown for this page.
   *
   * Decided when the search ran and carried on the source, so a `[N]` in the
   * prose resolves to the page the model meant however many searches the turn
   * made.
   */
  index: number;
}

/**
 * One thing a turn found that has a face: a picture, a clip, or a track.
 *
 * Plain links are not among them. They belong in a row of squares only if
 * there is something to put in the square, and a web page has nothing.
 */
export interface ChatAsset {
  /** Which of the three it is, which decides what the square holds. */
  kind: 'image' | 'video' | 'audio';
  /** Where it is. */
  url: string;
  /** What to call it. */
  title: string;
  /**
   * How long it runs, as it should read.
   *
   * Only a clip or a track has one, and only when the model gave it. A still
   * frame cannot say how long a video is, so without this a clip and a
   * picture are the same square.
   */
  duration?: string;
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
   * CLAUDE.md's XSS clause first, and the second one is the trap: handing it
   * to a markdown renderer with raw HTML enabled counts.
   */
  content: string;
  /** Optional hidden chain-of-thought, foldable in the UI. */
  thinking?: string;
  /** How long the turn thought, in milliseconds. Measured by the server. */
  thinkingMs?: number;
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
   * The model asked something and stopped to wait for the answer.
   *
   * Read off the mark the server writes, never off the tool names: which
   * tools block is a list in `@breatic/domain`, which this package may not
   * import. Without it this ending is an empty reply, which is also what a
   * turn that produced nothing looks like -- and that one is drawn as a
   * failure with a retry.
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
}
