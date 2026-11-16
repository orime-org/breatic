// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape a comment body takes. Shared so the browser's comments and an
 * external agent's (breatic#1488), written by collab, hold the same thing.
 */

/**
 * The user's words in the shape a comment body takes.
 *
 * A comment body is a BlockNote document, so one paragraph holding one text
 * run is the whole of a plain-text comment.
 * @param text - What the user wrote.
 * @returns That text as a comment body.
 */
export function asCommentBody(text: string): unknown {
  return [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }];
}
