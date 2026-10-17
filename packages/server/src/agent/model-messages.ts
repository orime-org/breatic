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
 * A row kept as it was sent (`for_model`) goes back as kept; this renders
 * the rows stored before that copy was kept, and is the replay's only way to
 * send them (`history-replay.ts`).
 */

import type { ModelMessage } from "ai";
import type { ToolResultPart } from "ai";

import { NOTHING_SAID_WHY, stripDsml } from "@breatic/shared";
import { userTurnForModel } from "@server/agent/user-turn.js";
import { EARLIER_RESULT_NOTE } from "@server/agent/stored-model-output.js";
import { ASK_USER } from "@breatic/domain";
import type { MessageData, MessagePart } from "@breatic/shared";

/** A tool part, once narrowed out of the union. */
type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * Whether this use of a tool is one the model is shown.
 *
 * A call still running has nothing to report yet, and a call whose arguments
 * never finished arriving is left out along with its own half: what was
 * stored is a partial parse, and replaying it puts words in the model's
 * mouth.
 * @param part - The tool part to judge.
 * @returns True when it reaches the model.
 */
function reachesTheModel(part: ToolPart): boolean {
  // A question the model asked is in the reply as words, written there by the
  // turn from this call's own payload. Sending the call and its result too
  // would put the same question in the context twice, on this turn and every
  // one after it, saying nothing the words do not. A question turned away is
  // the other way round: it is nowhere in the words, and the refusal is how
  // the model learns it was not asked, so it can ask once the first one is
  // answered.
  if (part.toolName === ASK_USER) return part.failure?.kind === "turned_away";
  return part.status !== "pending" && part.argumentsIncomplete !== true;
}

/**
 * What a tool returned, in the typed form the SDK requires.
 *
 * The field is a discriminated union, not a string — `ai@7.0.68` validates it
 * with `z.discriminatedUnion` before the request goes out, so handing over the
 * stored string is rejected at the door.
 *
 * A call that answered is handed back as the model was given it when the turn
 * ran, which the turn wrote down beside the answer (`forModel`). A structured
 * answer is never read here: it is in whatever shape the tool had when the row
 * was written, and reading it with the current code is what made conversations
 * fail every turn once a tool's answer gained a field (inner#1481).
 *
 * A row from before that copy was kept is either a string -- the model read
 * that string -- or a structured answer, which goes back as a note saying the
 * result is no longer available.
 *
 * Only called for parts that ended. What goes is the model's half of the
 * detail, never the key the panel translates, and a sentence saying as much
 * for the rows that predate the field.
 * @param part - The tool part to render
 * @returns The output in its typed form, saying plainly when the tool failed
 */
function toolOutput(part: ToolPart): ToolResultPart["output"] {
  if (part.status === "error") {
    // The field is newer than some of the rows it is read off, and a row
    // written before it existed has none. An empty string reads as a call
    // that failed for no reason at all, and what the model does next is
    // decided by this sentence.
    return { type: "error-text", value: part.failure?.forModel ?? NOTHING_SAID_WHY.forModel };
  }
  const copy = part.forModel;
  if (copy?.type === "text") return copy;
  if (copy?.type === "json") {
    // Written from the SDK's own JSON arm and stored as JSON, so it reads back
    // as the same JSON value.
    return { type: "json", value: copy.value as Extract<ToolResultPart["output"], { type: "json" }>["value"] };
  }
  if (typeof part.output === "string") return { type: "text", value: part.output };
  return { type: "text", value: EARLIER_RESULT_NOTE };
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
 * The note a reply ends on when its turn did not end on its own.
 *
 * Read off the reply's stored parts, which record how the turn ended, so a
 * row stored before its copy as sent was kept and a row with one end the
 * same way.
 * @param parts - The reply's stored parts.
 * @returns The note, or undefined for a turn that ended on its own.
 * @throws {never} Never.
 */
export function endingNote(parts: readonly MessagePart[]): string | undefined {
  if (parts.some((p) => p.type === "interrupted")) return STOP_NOTE;
  if (parts.some((p) => p.type === "failed")) return FAILED_NOTE;
  if (parts.some((p) => p.type === "truncated")) return TRUNCATED_NOTE;
  return undefined;
}

/**
 * Turn rows stored without a kept copy into the messages the model is sent.
 *
 * Such rows kept no signed thinking, so none goes back. A call still in flight
 * is left out along with its own half — a call with no answer puts the
 * exchange in a state the protocol has no move for.
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

  for (const message of history) {
    if (message.role === "user") {
      const attached = message.parts.flatMap((p) => (p.type === "attachment" ? [p.chip] : []));
      out.push({ role: "user", content: userTurnForModel({ chips: attached, message: message.content }) });
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
    const note = endingNote(message.parts);

    for (const part of message.parts) {
      if (part.type === "text") {
        out.push({ role: "assistant", content: stripDsml(part.text) });
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
            output: toolOutput(part),
          },
        ],
      });
    }
    if (note !== undefined) out.push({ role: "assistant", content: note });
  }

  return out;
}
