// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one channel everything wrong with chat is said on.
 *
 * Its own module rather than part of either store, because both of them speak
 * on it: the conversation store when a request it made came back badly, and a
 * `Chat` session when a turn failed. Held by either one, the other would have
 * to reach through it -- and the panel, which is the only listener, would have
 * two places to watch instead of one.
 */

import { t } from '@breatic/shared';
import { ourSentence } from '@web/data/api/server-message';

/**
 * Something that went wrong, told once to whoever is looking.
 *
 * Told, not kept. Every one of these belongs to a moment the user was in --
 * they pressed send, or a reply they were watching stopped arriving -- and a
 * moment does not wait around. Nobody watching means nobody is in that
 * moment: the panel is collapsed, or they are reading another conversation.
 * What they come back to is a conversation that stopped moving, which is how
 * a user watching a stream knows something went wrong, and it needs no sentence
 * from us repeating it later.
 *
 * The four kinds are not a matter of wording. What tells them apart is what
 * came back: `server` carries our sentence for the user -- the server's own
 * (out of credits, too many requests, not allowed), or, past a spend limit,
 * the one this end builds with the limit and its local reset day -- `turn`
 * is an answer that came back with none of ours in it, so there is nothing
 * to quote and this end has to supply the words, `network` is no answer at all, and `gone` is
 * our own 404, where the server did answer and what it said is that the
 * conversation is not there any more. That last one is not a failure, which
 * is why it is its own kind rather than a `server` sentence about a resource.
 */
export type ChatMishap = {
  /**
   * The user did this on purpose and is waiting to hear back.
   *
   * What separates a rename they just pressed from trouble in a conversation
   * they have since switched away from, such as a send still on its way when
   * they switched (inner#1717). The panel shows only its own
   * conversation's trouble -- except for this, which is theirs whichever
   * conversation it was about.
   */
  deliberate?: boolean;
  /** The project it happened in. */
  projectId: string;
  /** The conversation, or null when there is not one yet to speak of. */
  conversationId: string | null;
} & (
  | { kind: 'network' }
  | { kind: 'server'; message: string }
  // The stream reached us and the server said this turn is over without
  // saying anything a user could act on. Not `server`: that one carries the
  // sentence the server wrote for the user, and this one has none -- what
  // comes down the wire here is an English string written for us.
  | { kind: 'turn' }
  // The conversation asked for is not there any more, which our own server
  // said in so many words. Not `server` either: the sentence it sends is
  // about a resource, and this end knows the far more useful thing -- which
  // resource, and that nothing went wrong.
  | { kind: 'gone' }
);

const watchers = new Set<(mishap: ChatMishap) => void>();

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
export function tell(mishap: ChatMishap): void {
  for (const watch of watchers) watch(mishap);
}

/**
 * Read a failed request as the user would hear it.
 *
 * For every chat request that fails as a whole -- opening the chat, reaching
 * further back, switching, starting, renaming, removing, re-reading the list,
 * sending a message, answering a card, stopping and taking a message back.
 * Either we have a sentence about it or nothing does: the server's own, or,
 * for sending a message or answering a card past a spend limit, the
 * spend-limit one built here from the server's answer.
 *
 * A third case exists and is not told apart here: something answered, but
 * with nothing of ours in it. Saying "network error" for that is not right --
 * the network worked -- and there is no sentence yet that fits, so one has to
 * be written before this can tell the difference (todo #119).
 * @param err - Whatever the call threw.
 * @returns Which kind of mishap it is, and our sentence when there is one.
 */
export function readMishap(err: unknown): { kind: 'network' } | { kind: 'server'; message: string } {
  const said = ourSentence(err);
  return said === null ? { kind: 'network' } : { kind: 'server', message: said };
}

/**
 * The sentence a mishap is told with, in the user's language at the moment
 * it is told (inner#1530: a toast, said once).
 *
 * Our sentence passes through -- the server's own, or the spend-limit one
 * built from its answer, both written for the user in their language. A
 * conversation that is gone is not an error, so it says that. A turn that
 * answered with nothing of ours says the reply is not coming; no answer at
 * all says only that the network failed.
 * @param mishap - What happened.
 * @returns The sentence.
 */
export function mishapLine(mishap: ChatMishap): string {
  if (mishap.kind === 'gone') return t('chat.conversation.gone');
  if (mishap.kind === 'server') return mishap.message;
  if (mishap.kind === 'turn') return t('chat.error.turnFailed');
  return t('chat.error.network');
}
