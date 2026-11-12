// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message the run hands a turn, and what the turn is told about its run
 * (inner#1717).
 */
import type { ChatAttachedChip, ChatSpaceContext } from "@breatic/shared";

/** One message the user sent, as the run hands it to the turn. */
export interface TakenMessage {
  /** The id the page sent it with; the row or part it becomes is keyed by it. */
  id: string;
  /** When the user pressed send, ISO. */
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
