// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one channel everything wrong with chat is said on.
 *
 * Its own module rather than part of either store, because both of them speak
 * on it: the conversation store when a request it made came back badly, and a
 * `Chat` session when a turn failed. Held by either one, the other would have
 * to reach through it -- and the panel, which is the only listener, would have
 * two places to watch instead of one.
 */

import { ApiException } from '@web/data/api/types';

/**
 * Something that went wrong, told once to whoever is looking.
 *
 * Told, not kept. Every one of these belongs to a moment the reader was in --
 * they pressed send, or a reply they were watching stopped arriving -- and a
 * moment does not wait around. Nobody watching means nobody is in that
 * moment: the panel is collapsed, or they are reading another conversation.
 * What they come back to is a conversation that stopped moving, which is how
 * a reader of a stream knows something went wrong, and it needs no sentence
 * from us repeating it later.
 *
 * The four kinds are not a matter of wording. What tells them apart is what
 * came back: `server` carries the sentence the server wrote for the reader --
 * out of credits, too many requests, not allowed -- `turn` is an answer that
 * came back with none of ours in it, so there is nothing to quote and this
 * end has to supply the words, `network` is no answer at all, and `gone` is
 * our own 404, where the server did answer and what it said is that the
 * conversation is not there any more. That last one is not a failure, which
 * is why it is its own kind rather than a `server` sentence about a resource.
 */
export type ChatMishap = {
  /**
   * The reader did this on purpose and is waiting to hear back.
   *
   * What separates a rename they just pressed from a turn failing in some
   * other conversation in the background. The panel shows only its own
   * conversation's trouble -- except for this, which is theirs whichever
   * conversation it was about.
   */
  deliberate?: boolean;
  /**
   * It is about the list, or about one row in it.
   *
   * The list covers the whole column while it is open, so the panel's own
   * line -- on the top edge of the composer -- is a line nobody can read
   * then. This marks the words as ones the list can carry; whether they
   * actually go there is decided by whether the list is on screen, since the
   * header renames the conversation too and the list is shut for that.
   */
  aboutRow?: boolean;
  /**
   * Which telling this is.
   *
   * Two failures in a row say the same words, and a line that says the same
   * words is a line React leaves alone -- the DOM does not move and a screen
   * reader announces nothing. So the reader presses send a second time, it
   * fails a second time, and nothing whatever happens on screen. This is what
   * makes each telling its own: the panel keys the line by it, so the same
   * sentence is torn down and put up again, which is both visible and spoken.
   */
  at: number;
  /** The project it happened in. */
  projectId: string;
  /** The conversation, or null when there is not one yet to speak of. */
  conversationId: string | null;
} & (
  | { kind: 'network' }
  | { kind: 'server'; message: string }
  // The stream reached us and the server said this turn is over without
  // saying anything a reader could act on. Not `server`: that one carries the
  // sentence the server wrote for the reader, and this one has none -- what
  // comes down the wire here is an English string written for us.
  | { kind: 'turn' }
  // The conversation asked for is not there any more, which our own server
  // said in so many words. Not `server` either: the sentence it sends is
  // about a resource, and this end knows the far more useful thing -- which
  // resource, and that nothing went wrong.
  | { kind: 'gone' }
);

const watchers = new Set<(mishap: ChatMishap) => void>();

/** How many have been told, which is what makes each one its own. */
let told = 0;

/**
 * Be told when something goes wrong, for as long as you are looking.
 * @param watch - Called once per mishap.
 * @returns Call to stop watching.
 */
export function watchChatMishaps(watch: (mishap: ChatMishap) => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/**
 * Tell whoever is watching. Nobody watching means it is not told.
 * @param mishap - What went wrong.
 */
export function tell(mishap: Omit<ChatMishap, 'at'>): void {
  told += 1;
  const withIdentity = { ...mishap, at: told } as ChatMishap;
  for (const watch of watchers) watch(withIdentity);
}

/**
 * The sentence our own server wrote for this reader, if it wrote one.
 *
 * The whole of what this answers. What to say when it answers nothing is not
 * the same question in every place that asks, so it is left to whoever asked.
 * @param err - Whatever the call threw.
 * @returns The server's own words, or nothing when they are not the server's.
 */
function serverSentence(err: unknown): string | undefined {
  // Only a sentence our own server wrote for this reader. An answer coming
  // back is not the same thing: a gateway that timed out also answers, and
  // there is nothing of ours in what it sends -- so the exception says whether
  // the message it is carrying came out of our envelope, and this asks that
  // and nothing else.
  return err instanceof ApiException && err.fromServer ? err.message : undefined;
}

/**
 * Read a failed request as the reader would hear it.
 *
 * For every request that fetches rather than runs a turn -- opening the
 * chat, reaching further back, switching, starting, renaming, removing, and
 * re-reading the list. Either the server wrote a sentence about it or nothing
 * did.
 *
 * A third case exists and is not told apart here: something answered, but
 * with nothing of ours in it. Saying "network error" for that is not right --
 * the network worked -- and there is no sentence yet that fits, so one has to
 * be written before this can tell the difference (todo #119).
 * @param err - Whatever the call threw.
 * @returns Which kind of mishap it is, and the server's own words when it
 *   answered with any.
 */
export function readMishap(err: unknown): { kind: 'network' } | { kind: 'server'; message: string } {
  const said = serverSentence(err);
  return said === undefined ? { kind: 'network' } : { kind: 'server', message: said };
}
