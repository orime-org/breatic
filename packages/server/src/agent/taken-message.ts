// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message the run hands a turn, and what the turn is told about its run
 * (inner#1717).
 */
import type { ChatAttachedChip, ChatPendingItem, ChatSpaceContext } from "@breatic/shared";
import type { QueueItem } from "@server/modules/chat-queue/chat-queue.service.js";

/** One message the user sent, as the run hands it to the turn. */
export interface TakenMessage {
  /** The id the page sent it with; the row or part it becomes is keyed by it. */
  id: string;
  /** When the server accepted it, ISO. */
  sentAt: string;
  /** What the user typed. */
  message: string;
  /** What the user attached, in order. */
  chips: ChatAttachedChip[];
  /** The project's Spaces and the one the user had open when they sent it. */
  space: ChatSpaceContext;
  /** The zone the user's browser reported, if any. */
  timeZone?: string;
  /** The language the page asked in, which the turn speaks to the user in. */
  locale?: string;
  /** The model the user had picked, if any. */
  model?: string;
}

/** How a turn ended, once its reply is written down or has failed to be. */
export interface TurnEnded {
  /** How the turn ended. */
  exit: "aborted" | "failed" | "too_long" | "blocked" | "completed";
  /** Whether the reply row was stored. */
  stored: boolean;
  /**
   * The messages the stored reply holds, by id: the opening and each one it
   * took in. One taken from the queue and not among them was never written
   * down, so it waits again.
   */
  recorded: string[];
  /** The card the turn stopped at, when it did. */
  awaitingCall?: string;
  /** Whether the turn was cut off because the server was shutting down. */
  shutdown?: boolean;
}

/** What a run lends the turn it runs. */
export interface TurnHooks {
  /** The id of the message that opened the turn; its user row is written under it. */
  messageId?: string;
  /** Messages taken with the opening, read in the first step. */
  alsoTaken?: TakenMessage[];
  /** Moves what waits into the run and hands it over; called before each step that may take messages. */
  drain?: () => Promise<TakenMessage[]>;
  /** The charge key, when it is not the turn's own. */
  operationKey?: string;
  /**
   * Runs once the opening row is written and before the model is asked
   * anything: the rest of the run's opening stage. A throw ends the turn there.
   */
  beforeStream?: (turnIndex: number) => Promise<void>;
  /** Told how the turn ended, after its reply was written down or failed to be. */
  onEnded?: (ended: TurnEnded) => void;
}

/**
 * A queued message, as the turn reads it.
 * @param item - The queue item.
 * @returns The message.
 */
export function takenMessageOf(item: QueueItem): TakenMessage {
  const { current_space: current, spaces, spaces_total: total } = item;
  return {
    id: item.id,
    sentAt: item.sentAt,
    message: item.message,
    chips: item.attached_chips,
    space: {
      ...(current === undefined ? {} : { current_space: current }),
      ...(spaces === undefined ? {} : { spaces }),
      ...(total === undefined ? {} : { spaces_total: total }),
    },
    ...(item.time_zone === undefined ? {} : { timeZone: item.time_zone }),
    locale: item.acceptLanguage,
    ...(item.model === undefined ? {} : { model: item.model }),
  };
}

/**
 * A message as a page draws it: in the waiting area, and where a run took it in.
 * @param m - The message.
 * @returns What the page is given.
 */
export function userMessageData(m: TakenMessage): ChatPendingItem {
  return { id: m.id, words: m.message, chips: m.chips, sentAt: m.sentAt };
}
