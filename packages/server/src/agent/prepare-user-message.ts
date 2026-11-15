// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message the user sent, made into the user message the model is given
 * (inner#1717). The turn's opening and every message it takes in while it
 * runs go through here, so each is given the same way: its pictures
 * prepared, its open Space in full only when it changed since it was last
 * sent whole, and its links counted as the user's.
 */
import type { ModelMessage } from "ai";
import type { PrepareAgentPictures } from "@breatic/domain";
import type { PageLinks } from "@server/agent/page-links.js";
import { pictureSourcesForTurn } from "@server/agent/prepare-pictures.js";
import { openSpaceKey, userMessageForModel, type PreparedPicture, type UserTurn } from "@server/agent/user-turn.js";

/** A user message as the model is given it, and what the turn keeps of it. */
export interface PreparedUserMessage {
  message: ModelMessage;
  /** The turn with its pictures prepared, for a caller that prepares it once. */
  turn: UserTurn;
  /** The pictures it carries, for the request's picture facts and the kept copy. */
  pictures: readonly PreparedPicture[];
  /** Its open Space as sent, and whether it went in full. */
  snapshot?: { spaceId: string; key: string; full: boolean };
}

/** What preparing a message needs of the turn. */
export interface PrepareUserMessageWith {
  /** Whether the turn's model reads pictures. */
  seesPictures: boolean;
  preparePictures: PrepareAgentPictures;
  /** The key the open Space was last sent whole under, by Space. */
  lastSentInFull: (spaceId: string) => string | undefined;
  pageLinks: PageLinks;
  signal?: AbortSignal;
}

/**
 * Prepare one message the user sent.
 * @param said - Its clock line and what it carries; a turn already prepared keeps its pictures.
 * @param said.clockNote - The user's clock when it was sent.
 * @param said.turn - The words, attachments and Spaces.
 * @param how - What the turn lends.
 * @returns The user message and what to keep of it.
 * @throws {Error} When the turn was stopped while pictures were prepared.
 */
export async function prepareUserMessage(said: { clockNote: string; turn: UserTurn }, how: PrepareUserMessageWith): Promise<PreparedUserMessage> {
  let turn = said.turn;
  if (turn.pictures === undefined) {
    const prepared = how.seesPictures ? await how.preparePictures(pictureSourcesForTurn(turn.chips), how.signal) : [];
    how.signal?.throwIfAborted();
    turn = {
      ...turn,
      pictures: prepared.flatMap((one) => one.status === "ready" ? [{
        label: one.label, sourceUrl: one.sourceUrl, url: one.url, sizeBytes: one.sizeBytes, mediaType: one.mediaType,
      }] : []),
      pictureFailures: prepared.flatMap((one) => one.status === "unavailable" ? [{
        label: one.label, sourceUrl: one.sourceUrl, reason: one.reason,
      }] : []),
    };
  }
  const open = openSpaceKey(turn.current_space);
  const unchanged = open !== undefined && how.lastSentInFull(open.spaceId) === open.key;
  const message: ModelMessage = { role: "user", content: userMessageForModel(said.clockNote, turn, unchanged) };
  how.pageLinks.addUserMessage(message);
  return {
    message,
    turn,
    pictures: turn.pictures ?? [],
    ...(open === undefined ? {} : { snapshot: { ...open, full: !unchanged } }),
  };
}
