// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Stored history, in the form the model is given.
 *
 * These are two shapes for two audiences and they are not the same shape.
 * Storage keeps one message per turn with its pieces in order — the reply and
 * everything it did along the way, which is what a person reads. The protocol
 * wants the same history split differently: a tool call belongs to the
 * assistant, its result arrives as a message of its own.
 *
 * The conversion is one function because both chat entry points need it and a
 * second copy would drift; it is here rather than in the repository because
 * the repository answers to every reader, and only this one wants the
 * protocol's shape.
 */

import type { ModelMessage } from "ai";
import type { ToolResultPart } from "ai";

import { NOTHING_SAID_WHY } from "@breatic/shared";
import { renderSearchForModel } from "@breatic/domain";
import type { SearchAnswer } from "@breatic/domain";
import type { MessageData, MessagePart } from "@breatic/shared";

/** A tool part, once narrowed out of the union. */
type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * Tools whose answer is one thing to the panel and another to the model.
 *
 * A tool that answers with a structured object says here how that object
 * reads as text. The knowledge belongs to the tool -- what keeps page text
 * from writing markup of the tool's own is the tool's business -- and the
 * count belongs here, because only something walking the whole history knows
 * how many sources a turn has already shown.
 *
 * The SDK has a field for the first half (`toModelOutput`) and it is declared
 * too, for any caller that reaches it. This table is what `toModelMessages`
 * reaches, because the SDK's signature has nowhere to put the count.
 */
const RENDER_FOR_MODEL: Record<string, (output: unknown, startIndex: number) => string> = {
  web_search: (output, startIndex) =>
    renderSearchForModel(output as SearchAnswer, startIndex),
};

/**
 * How many sources a tool result showed the model.
 *
 * Only the tools in the table above put numbered sources in front of the
 * model, and only a call that ended successfully put any there at all.
 * @param part - The tool part.
 * @returns The count, or zero for a part that showed none.
 */
function sourcesShownBy(part: ToolPart): number {
  if (part.status !== "success" || typeof part.output === "string") return 0;
  if (RENDER_FOR_MODEL[part.toolName] === undefined) return 0;
  const sources = (part.output as { sources?: unknown } | null)?.sources;
  return Array.isArray(sources) ? sources.length : 0;
}

/**
 * Whether this use of a tool is one the model is shown.
 *
 * A call still running has nothing to report yet, and a call whose arguments
 * never finished arriving is left out along with its own half: what was
 * stored is a partial parse, and replaying it puts words in the model's
 * mouth.
 *
 * Exported because compaction counts in the same unit. Counting the ones the
 * model never sees would spend the configured window on them.
 * @param part - The tool part to judge.
 * @returns True when it reaches the model.
 */
export function reachesTheModel(part: ToolPart): boolean {
  return part.status !== "pending" && part.argumentsIncomplete !== true;
}

/**
 * Render what a tool returned in the typed form the SDK requires.
 *
 * The field is a discriminated union, not a string — `ai@7.0.68` validates it
 * with `z.discriminatedUnion` before the request goes out, so handing over the
 * stored string is rejected at the door.
 *
 * Which arm depends on what the tool answered with, and every arm is real.
 * The interaction tools answer with the object the panel needs to draw the
 * question, and it goes on whole. `web_search` answers with an object too,
 * but the model is given a rendering of it -- putting the sources in front of
 * it as JSON would leave it reading a field name where a page's text should
 * be. Putting an object in the `text` arm fails validation, and it fails
 * inside the stream -- nothing reaches the screen and nothing says why, so a
 * conversation goes quiet from its first interaction tool onward.
 *
 * Only called for parts that ended. What goes is the model's half of the
 * detail, never the key the panel translates, and a sentence saying as much
 * for the rows that predate the field.
 * @param part - The tool part to render
 * @param sourcesSoFar - How many sources this turn has already numbered
 * @returns The output in its typed form, saying plainly when the tool failed
 */
function toolOutput(part: ToolPart, sourcesSoFar: number): ToolResultPart["output"] {
  if (part.status === "error") {
    // The field is newer than some of the rows it is read off, and a row
    // written before it existed has none. An empty string reads as a call
    // that failed for no reason at all, and what the model does next is
    // decided by this sentence.
    return { type: "error-text", value: part.failure?.forModel ?? NOTHING_SAID_WHY.forModel };
  }
  // Ahead of the tool table, and that order is the whole point. `output` gets
  // here in three shapes and only the first is what a tool just produced: a
  // row stored before the structured output existed is a string, and so is
  // the placeholder compaction leaves behind when a result no longer fits the
  // window. A renderer reading `output.sources` off either of those throws
  // while the request is being assembled -- so the turn never starts, which is
  // what every long conversation would meet.
  if (typeof part.output === "string") return { type: "text", value: part.output };
  const render = RENDER_FOR_MODEL[part.toolName];
  if (render !== undefined) {
    return { type: "text", value: render(part.output, sourcesSoFar) };
  }
  // Whatever the tool answered with, as it was stored. It came out of a
  // `JSON.stringify` on the way into the table, so it is JSON by
  // construction -- the cast says that rather than re-deriving it.
  return {
    type: "json",
    value: (part.output ?? null) as Extract<
      ToolResultPart["output"],
      { type: "json" }
    >["value"],
  };
}

/**
 * The note that says a turn did not get to finish.
 *
 * The model reads its own past replies to know what it has already said. A
 * reply that was cut off looks, on the way back in, exactly like one it chose
 * to end there -- so it carries on as though the answer were given, and the
 * user never gets the rest.
 *
 * Says the connection ended rather than that the user pressed stop, because
 * pressing stop is not what this side is told. The route has one signal for
 * it (`s.onAbort`, raised when the client goes away) and it covers the stop
 * button, a closed tab, a dropped network and a sleeping laptop alike. Told
 * the first when it was the third, the model opens the next turn apologising
 * for something the user never did. Telling the two apart needs the browser
 * to say which it was, which is task #149.
 */
const STOP_NOTE = "[This turn did not finish: the connection to the user closed.]";

/**
 * The note that says a turn broke off on its own.
 *
 * Worded apart from the stop above because the two lead somewhere different:
 * a turn the user stopped was not wanted, a turn that broke off was. Reading
 * the second as the first would have the model wait to be asked again for
 * something it should offer to finish.
 */
const FAILED_NOTE = "[This turn could not be finished; it broke off partway.]";

/**
 * The note that says a turn ran out of room rather than out of things to say.
 *
 * Apart from both above because it leads somewhere neither does: what the
 * model was saying is still wanted and nothing about it went wrong, so the
 * turn to make of this is to carry on from where the sentence stops.
 */
const TRUNCATED_NOTE = "[This turn was cut off at the output limit, mid-sentence.]";

/**
 * Turn stored messages into the messages the model is sent.
 *
 * Reasoning never goes back: it is the model's own working, and returning it
 * teaches nothing while costing every turn. A call still in flight is left out
 * along with its own half — a call with no answer puts the exchange in a state
 * the protocol has no move for.
 *
 * A call the user stopped does go back, saying so. It used to be dropped whole,
 * which left the next turn reading as one the model had finished answering: it
 * had no way to know its own reply had been cut off, and carried on as though
 * it had.
 * @param history - Stored messages, oldest first
 * @returns The same history in protocol form, oldest first
 */
export function toModelMessages(history: readonly MessageData[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  // What the model has been shown, counted as this walk goes. The model writes
  // `[N]` against one space of numbers, so a turn that searched twice must not
  // hand it two sources called `1`.
  let sourcesSoFar = 0;

  for (const message of history) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    // A fact about the turn, so it is said once at the end of it. The SDK
    // opens a fresh text part per step, and a note on each would tell the
    // model it stopped and then went on -- with the first landing before a
    // tool call it made afterwards.
    //
    // Said on the assistant's own message rather than as a message of its
    // own: a `system` message in the middle of a conversation is a shape
    // some providers reject, and a `user` one would be words the user never
    // said. Bracketed so the model reads it as a note about the turn rather
    // than as something it wrote.
    const stopped = message.parts.some((p) => p.type === "interrupted");
    const brokeOff = message.parts.some((p) => p.type === "failed");
    const cutOff = message.parts.some((p) => p.type === "truncated");

    for (const part of message.parts) {
      if (part.type === "text") {
        out.push({ role: "assistant", content: part.text });
        continue;
      }

      if (part.type !== "tool" || !reachesTheModel(part)) continue;

      out.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          },
        ],
      });
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toolOutput(part, sourcesSoFar),
          },
        ],
      });
      sourcesSoFar += sourcesShownBy(part);
    }
    if (stopped) out.push({ role: "assistant", content: STOP_NOTE });
    else if (brokeOff) out.push({ role: "assistant", content: FAILED_NOTE });
    else if (cutOff) out.push({ role: "assistant", content: TRUNCATED_NOTE });
  }

  return out;
}
