// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each card on the panel says (#18, A4 · A9 · A13).
 *
 * {@link useCommentRail} answers which cards there are, in what order, in
 * which state. This answers what is written on them, which takes three more
 * readings: the thread itself for its comments, the body for the words the
 * comment is about, and the user store for who wrote each one.
 *
 * THE QUOTE IS READ FROM THE BODY, NOT STORED. A comment points at a range,
 * and the range moves and shrinks as the document is edited — a quote copied
 * at posting time would keep naming words that are no longer there. An orphan
 * has no range left and so has no quote; that is what the card says instead
 * (A13).
 *
 * Names are resolved through the library's own store, which caches, de-dupes
 * and merges concurrent requests. A name it has no entry for reads as null and
 * the card says it does not know who — the account was soft-deleted, and the
 * comment outlives it.
 */

import { CommentsExtension } from '@blocknote/core/comments';
import type { CommentData, ThreadData } from '@blocknote/core/comments';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as React from 'react';

import type { RailCard } from '@web/spaces/document/document-comment-rail';
import type {
  CommentCardState,
  ThreadRange,
} from '@web/spaces/document/document-comment-state';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import { onEditorSettled } from '@web/spaces/document/use-editor-snapshot';
import { useCommentRail } from '@web/spaces/document/use-comment-rail';

/** One comment inside a card: the opening one, or a reply below it. */
export interface CommentEntryView {
  /** The comment's own id, which is what deleting one names. */
  readonly id: string;
  /** Who wrote it, or null while the store has no entry for them. */
  readonly author: string | null;
  /** Their account id, for deciding what this reader may do to it. */
  readonly authorId: string;
  /** What it says, as plain text. */
  readonly body: string;
  /** When it was written. */
  readonly createdAt: Date;
}

/** One card, with everything drawn on it. */
export interface CommentCardView {
  /** The thread this card is for. */
  readonly id: string;
  /** Which of the four states it is in (§9.2). */
  readonly state: CommentCardState;
  /** The words it is about, or null once they are gone. */
  readonly quote: string | null;
  /** The opening comment and every reply, oldest first. */
  readonly entries: readonly CommentEntryView[];
}

/** The two groups the panel draws. */
export interface CommentCards {
  /** Open and orphaned, in body order. */
  readonly unresolved: readonly CommentCardView[];
  /** Resolved, in the same order. */
  readonly resolved: readonly CommentCardView[];
}

/** What an editor with no comments draws, one object for every such read. */
const NO_CARDS: CommentCards = { unresolved: [], resolved: [] };

/** The extension's half of the reading, as this module needs it. */
interface CommentsSource {
  readonly threadStore: {
    getThreads(): Map<string, ThreadData>;
    subscribe(listener: () => void): () => void;
  };
  readonly store: {
    readonly state: { threadPositions: ReadonlyMap<string, ThreadRange> };
    subscribe(listener: () => void): () => void;
  };
  readonly userStore: {
    getUser(id: string): { username: string } | undefined;
    loadUsers(ids: string[]): Promise<void>;
    store: { subscribe(listener: () => void): () => void };
  };
}

/**
 * The comments extension on this editor, if it has one.
 * @param editor - The editor to ask.
 * @returns Its comments extension, or undefined.
 */
function commentsOn(editor: ToolEditor): CommentsSource | undefined {
  return (
    editor as unknown as {
      getExtension(factory: unknown): CommentsSource | undefined;
    }
  ).getExtension(CommentsExtension);
}

/**
 * Reads a comment body down to the text in it.
 *
 * A body is a BlockNote document, so this walks whatever blocks it holds and
 * keeps the text runs. Ours writes one paragraph; a peer on a build with a
 * richer composer can write more, and the card shows what it can read.
 * @param body - The comment's body.
 * @returns Its text, blocks separated by newlines.
 */
function bodyText(body: unknown): string {
  if (!Array.isArray(body)) return '';
  return body
    .map((block: unknown) => {
      const content = (block as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content
        .map((run: unknown) => (run as { text?: string }).text ?? '')
        .join('');
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Reads one comment into what its entry shows.
 * @param comment - The comment.
 * @param source - Where names are resolved.
 * @returns The entry.
 */
function entryOf(
  comment: CommentData,
  source: CommentsSource,
): CommentEntryView {
  return {
    id: comment.id,
    author: source.userStore.getUser(comment.userId)?.username ?? null,
    authorId: comment.userId,
    body: bodyText(comment.body),
    createdAt: comment.createdAt,
  };
}

/**
 * Reads one thread into the card that stands for it.
 * @param card - Which thread, and which state the panel put it in.
 * @param source - The threads and their positions.
 * @param doc - The body, which the quote is read out of.
 * @returns The card, or null once the thread itself is gone.
 */
function drawCard(
  card: RailCard,
  source: CommentsSource,
  doc: ProseMirrorNode,
): CommentCardView | null {
  const thread = source.threadStore.getThreads().get(card.id);
  if (thread === undefined) return null;
  const at = source.store.state.threadPositions.get(card.id);
  return {
    id: card.id,
    state: card.state,
    quote: at === undefined ? null : doc.textBetween(at.from, at.to),
    entries: thread.comments.map((comment) => entryOf(comment, source)),
  };
}

/**
 * Whether two cards would be drawn the same.
 * @param a - One card.
 * @param b - The other.
 * @returns True when nothing drawn on them differs.
 */
function sameCard(a: CommentCardView, b: CommentCardView): boolean {
  return (
    a.id === b.id &&
    a.state === b.state &&
    a.quote === b.quote &&
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) => {
      const other = b.entries[index];
      return (
        other !== undefined &&
        entry.id === other.id &&
        entry.author === other.author &&
        entry.body === other.body
      );
    })
  );
}

/**
 * Whether two readings would draw the same panel.
 * @param a - The previous reading.
 * @param b - The one just taken.
 * @returns True when the panel would look the same.
 */
function sameCards(a: CommentCards, b: CommentCards): boolean {
  return (
    a.unresolved.length === b.unresolved.length &&
    a.resolved.length === b.resolved.length &&
    a.unresolved.every((card, i) => sameCard(card, b.unresolved[i]!)) &&
    a.resolved.every((card, i) => sameCard(card, b.resolved[i]!))
  );
}

/**
 * Reads everything the panel draws, and keeps it current.
 * @param editor - The document editor.
 * @returns The two groups, each card carrying its quote and its comments.
 */
export function useCommentCards(editor: ToolEditor): CommentCards {
  const rail = useCommentRail(editor);
  const comments = commentsOn(editor);
  const cached = React.useRef<CommentCards>(NO_CARDS);

  const subscribe = React.useCallback(
    (onChange: () => void): (() => void) => {
      if (comments === undefined) return () => undefined;
      // The body as well as the stores: the quote is read out of the document,
      // so editing inside a commented range changes what a card says without
      // touching any thread.
      const stops = [
        comments.threadStore.subscribe(onChange),
        comments.store.subscribe(onChange),
        comments.userStore.store.subscribe(onChange),
        onEditorSettled(editor as never, onChange),
      ];
      return () => {
        stops.forEach((stop) => {
          stop();
        });
      };
    },
    [comments, editor],
  );

  const read = React.useCallback((): CommentCards => {
    if (comments === undefined) return NO_CARDS;
    const doc = editor.prosemirrorState.doc;
    const next: CommentCards = {
      unresolved: rail.unresolved
        .map((card) => drawCard(card, comments, doc))
        .filter((card) => card !== null),
      resolved: rail.resolved
        .map((card) => drawCard(card, comments, doc))
        .filter((card) => card !== null),
    };
    if (sameCards(cached.current, next)) return cached.current;
    cached.current = next;
    return next;
  }, [comments, editor, rail]);

  const cards = React.useSyncExternalStore(subscribe, read, read);

  // Asking for every author on screen. The store skips ids it already holds
  // or is already fetching, so this is safe to run on every change.
  React.useEffect(() => {
    if (comments === undefined) return;
    const ids = new Set<string>();
    [...cards.unresolved, ...cards.resolved].forEach((card) => {
      card.entries.forEach((entry) => {
        if (entry.author === null) ids.add(entry.authorId);
      });
    });
    if (ids.size > 0) void comments.userStore.loadUsers([...ids]);
  }, [cards, comments]);

  return cards;
}
