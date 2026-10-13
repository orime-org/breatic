// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * DSML markup taken out of an Agent reply.
 *
 * DSML is the text DeepSeek writes a tool call in. When the arguments inside
 * are not valid JSON the provider cannot turn the block into a call, so it
 * hands the markup back as reply text next to a call whose arguments are
 * `{}`. That call is rejected and the model retries; the markup is only
 * noise a reader should not see, and it would be stored and sent back to the
 * model with the rest of the reply.
 *
 * The block always closes the model's message, so everything from its opener
 * on is dropped. A tag on its own, which the model sometimes writes while
 * talking about a call, loses only the tag.
 */

/** Where a call block starts. */
const BLOCK_OPENER = /<｜DSML｜(?:tool_calls|function_calls)>/;

/**
 * A tag on its own, including one cut off before its `>`. Tag attributes
 * never span lines, so an unfinished tag ends at the end of its line.
 */
const LONE_TAG = /<\/?｜DSML｜[^>\n]*>?/g;

/** How an opening and a closing tag start. */
const TAG_STARTS = ["<｜DSML｜", "</｜DSML｜"] as const;

/**
 * Where the call block in a piece of text starts.
 * @param text - Reply text.
 * @returns The index of the block opener, or -1 when there is none.
 */
export function dsmlBlockStart(text: string): number {
  return text.search(BLOCK_OPENER);
}

/**
 * Take DSML markup out of reply text.
 * @param text - Reply text.
 * @returns The text before any call block, with lone tags removed.
 */
export function stripDsml(text: string): string {
  const block = dsmlBlockStart(text);
  return (block === -1 ? text : text.slice(0, block)).replace(LONE_TAG, "");
}

/**
 * Where the tail of a streamed piece of text could still turn into a tag
 * once more text arrives: the start of a tag that has not reached its `>`,
 * or a tail that is the beginning of one.
 * @param text - The text received so far and not yet passed on.
 * @returns The index from which the text has to wait; `text.length` when
 *   none of it does.
 */
export function dsmlHeldFrom(text: string): number {
  const last = text.lastIndexOf("<");
  if (last === -1) return text.length;
  const tail = text.slice(last);
  const couldBeTag = TAG_STARTS.some(
    (start) => start.startsWith(tail) || (tail.startsWith(start) && !/[>\n]/.test(tail)),
  );
  return couldBeTag ? last : text.length;
}
