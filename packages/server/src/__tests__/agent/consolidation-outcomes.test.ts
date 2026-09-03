// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How one consolidation ends (#148, N4 N6 N7 N9 N10 T3).
 *
 * Consolidation moved in front of the reply, so its failures are now on the
 * path of a turn somebody is waiting for, and the turn goes out however this
 * ends. What the endings differ on is the watermark, and the line they fall
 * on either side of is whether the model ran.
 *
 * A fold that reached it and then failed gives the window up. Keeping it for
 * next turn is what wedges a conversation: the call is `temperature: 0`, so
 * the next turn would send a strictly larger version of an input that already
 * failed, deterministically, forever — three model calls burnt each time, and
 * no refresh or relogin changes any of it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import type { ModelMessage } from "ai";

const generateTextRetry = vi.fn();
const chargeOnceForGeneration = vi.fn(async (..._args: unknown[]) => null);
const commitConsolidation = vi.fn<(...args: unknown[]) => Promise<"written" | "superseded">>();
const discardConsolidation = vi.fn<(...args: unknown[]) => Promise<boolean>>();
// The one door into the memory module: what a turn is injected with is what
// the fold is shown as the state it is rewriting.
const buildContext = vi.fn<
  (...args: unknown[]) => Promise<{ projectMemory: string; conversationMemory: string }>
>(async () => ({
  projectMemory: "the project so far",
  conversationMemory: "what was settled so far",
}));

// Set apart from what `config/agent.yaml` ships and from what `mock-core`
// answers, both 16384: an assertion whose two sides are the same 16384 is
// satisfied by an implementation that writes the number in.
const OUTPUT_CEILING = 4242;

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({
      ...(base.getAgentConfig as () => Record<string, unknown>)(),
      max_output_tokens: OUTPUT_CEILING,
    }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...base,
    generateTextRetry,
    getModel: (id: string) => ({ modelId: id }),
    resolveProvider: () => "test",
    // The real one. What it puts on the call is the thing being asserted,
    // and a stub would be answering the question with its own return value.
    reasoningFor: actual.reasoningFor,
    creditLotService: { chargeOnceForGeneration },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    memoryService: {
      commitConsolidation,
      discardConsolidation,
      buildContext,
    },
  };
});

const { consolidateWindow } = await import("@server/agent/memory-consolidator.js");
const { logger } = await import("@breatic/core");
const { creditsForTokens } = await import("@server/modules/credit/token-pricing.js");

const USER = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

/**
 * The window as the caller hands it over: compressed, then converted.
 *
 * Run through the real compressor rather than written out with a placeholder
 * already in it. N10 is the claim that a consolidation reads what compression
 * left behind, and a fixture carrying its own placeholder proves only that a
 * string put in comes back out.
 * @returns The window, in the shape `foldIfOverBudget` builds it.
 */
async function compressedWindow(): Promise<ModelMessage[]> {
  const { compressForContext } = await import("@server/agent/message-compressor.js");
  const { toModelMessages } = await import("@server/agent/model-messages.js");
  const history = [1, 2, 3, 4].flatMap((n) => [
    {
      role: "user" as const,
      content: `read page ${n}`,
      parts: [{ type: "text" as const, text: `read page ${n}` }],
      ts: "",
      turnIndex: n,
    },
    {
      role: "assistant" as const,
      content: "they all describe the same technique",
      parts: [
        {
          type: "tool" as const,
          toolCallId: `c${n}`,
          toolName: "web_fetch",
          input: { url: `https://example.test/${n}` },
          status: "success" as const,
          output: `the whole of page ${n}`,
        },
        { type: "text" as const, text: "they all describe the same technique" },
      ],
      ts: "",
      turnIndex: n,
    },
  ]);
  // One use more than the keep window, so the oldest loses its body.
  return toModelMessages(compressForContext(history, 3));
}

const TRANSCRIPT: ModelMessage[] = await compressedWindow();

/**
 * Ask for one consolidation, with everything the caller would have worked out.
 * @param over - Fields to change for this case.
 * @returns Whatever the consolidation ended as.
 */
async function consolidate(over: Record<string, unknown> = {}) {
  return consolidateWindow({
    userId: USER,
    conversationId: CONVERSATION,
    projectId: PROJECT,
    transcript: TRANSCRIPT,
    watermarkBefore: 7,
    newWatermark: 19,
    ...over,
  });
}

/** A model answer in the shape the consolidation prompt asks for. */
const GOOD_ANSWER = {
  text: JSON.stringify({
    conversationUpdate: "they settled on one technique",
    projectUpdate: "the project uses that technique",
    historyEntry: "read three pages",
  }),
  usage: { totalTokens: 400 },
};

beforeEach(() => {
  vi.clearAllMocks();
  generateTextRetry.mockResolvedValue(GOOD_ANSWER);
  commitConsolidation.mockResolvedValue("written");
  // `clearAllMocks` forgets calls, not implementations: a case that made one
  // of these reject would otherwise leave it rejecting for every case after.
  chargeOnceForGeneration.mockResolvedValue(null);
  discardConsolidation.mockResolvedValue(true);
});

describe("a consolidation that works", () => {
  it("writes both layers and moves the watermark in one call", async () => {
    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(commitConsolidation).toHaveBeenCalledTimes(1);
    expect(commitConsolidation.mock.calls[0]?.[0]).toMatchObject({
      userId: USER,
      conversationId: CONVERSATION,
      projectId: PROJECT,
      newWatermark: 19,
      data: {
        conversationUpdate: "they settled on one technique",
        projectUpdate: "the project uses that technique",
      },
    });
    expect(discardConsolidation).not.toHaveBeenCalled();
  });

  it("records the fold, which spent money and moved the watermark", async () => {
    // The one path through here that changes something and says nothing: a
    // fold that worked charged the studio and took turns out of the history,
    // and at 3am the only account of either is what was written down.
    await consolidate();

    const said = vi.mocked(logger.info).mock.calls.map((call) => call[1]);
    expect(said).toContain("memory_consolidation_written");
  });

  it("names the line for what the fold actually did", async () => {
    // A fold whose write matched no row spent the tokens and wrote nothing.
    // Called `written`, the one line about it says the opposite of what
    // happened, and the watermark in its fields never landed anywhere.
    commitConsolidation.mockResolvedValue("superseded");

    const outcome = await consolidate();

    expect(outcome).toBe("superseded");
    const said = vi.mocked(logger.info).mock.calls.map((call) => call[1]);
    expect(said).toContain("memory_consolidation_superseded");
    expect(said).not.toContain("memory_consolidation_written");
  });

  it("reads the window it was handed, placeholders and all", async () => {
    // N10: the input is the assembled messages the budget was measured
    // against, not the stored rows. A consolidation reading storage would see
    // the whole of every tool result, which is the thing compression just
    // took out.
    await consolidate();

    const prompt = String(
      (generateTextRetry.mock.calls[0]?.[0] as { messages: { content: string }[] })
        .messages[0]?.content,
    );
    expect(prompt).toContain("[earlier tool result omitted from context]");
    expect(prompt).toContain("they all describe the same technique");
  });

  it("bounds what the consolidating model may write", async () => {
    // N9: conversation memory is rewritten whole by this call, so an
    // unbounded answer is an unbounded segment of every later prompt.
    await consolidate();

    const call = generateTextRetry.mock.calls[0]?.[0] as { maxOutputTokens?: number };
    expect(call.maxOutputTokens).toBe(OUTPUT_CEILING);
  });

  it("tells the provider outright that this call wants no reasoning", async () => {
    // Folding a transcript into a summary has no reasoning step in it, and
    // saying nothing is not the same as saying no: DeepSeek turns thinking
    // on by model id unless told otherwise, and this call runs on a DeepSeek
    // model. Leaving the field off spends reasoning tokens on every fold and
    // drops the `temperature: 0` this function's own docstring depends on.
    await consolidate();

    const call = generateTextRetry.mock.calls[0]?.[0] as {
      providerOptions?: Record<string, Record<string, unknown>>;
    };
    // The whole object, because the direction is the point. Asserting that
    // one provider is addressed and its object is non-empty is true of the
    // on spelling as well, so it holds the call to no direction at all.
    //
    // `openrouter` because this suite's `getAgentConfig` double names no
    // consolidation model, so the route falls back the way any unnamed one does.
    expect(call.providerOptions).toEqual({
      openrouter: { reasoning: { effort: "none" } },
    });
  });

  it("tells the model the ceiling its answer is read through", async () => {
    // The token ceiling above and the character ceiling the injection applies
    // are two different numbers, and the second is the smaller by far. A
    // model asked for a complete rewrite that preserves every fact, and never
    // told where the reading stops, writes past it — and `buildContext` cuts
    // mid-sentence, silently, taking the most recently folded turns with it.
    const { getAgentConfig } = await import("@breatic/core");
    const limit = getAgentConfig().memory_conversation_max_size;

    await consolidate();

    const prompt = String(
      (generateTextRetry.mock.calls[0]?.[0] as { messages: { content: string }[] })
        .messages[0]?.content,
    );
    expect(prompt).toContain(String(limit));
  });

  it("puts the window where the prompt says the window goes", async () => {
    // The stored memory is spliced in before the transcript's own
    // placeholder, so memory holding the literal `{messages}` is where the
    // transcript lands — and the section that asks for the window is left
    // showing the placeholder. A model told there is nothing to fold answers
    // about nothing, and the watermark moves past the window all the same.
    buildContext.mockResolvedValueOnce({
      projectMemory: "",
      conversationMemory: "remember exactly: my template is {messages}",
    });

    await consolidate();

    const prompt = String(
      (generateTextRetry.mock.calls[0]?.[0] as { messages: { content: string }[] })
        .messages[0]?.content,
    );
    expect(prompt).toContain("Messages to consolidate:\n[user]");
    // The reader's own words stay their own words: what they asked to be
    // remembered is shown back as memory, in the memory section.
    expect(prompt).toContain("my template is {messages}");
  });

  it("puts the window in verbatim, dollar signs and all", async () => {
    // `$&` and the backtick form are replacement patterns, not text, so a
    // transcript carrying either rewrites the prompt around it. Anyone who
    // pasted a regex or a shell line into the conversation has one.
    const withDollars = [
      { role: "user" as const, content: "my regex is $`abc$& and $' too" },
    ];

    await consolidate({ transcript: withDollars });

    const prompt = String(
      (generateTextRetry.mock.calls[0]?.[0] as { messages: { content: string }[] })
        .messages[0]?.content,
    );
    expect(prompt).toContain("my regex is $`abc$& and $' too");
  });

  it("bills the studio once for the window it consumed", async () => {
    // T3: the key is the conversation and the watermark it started from, so
    // two tabs that computed the same window pay for it once.
    await consolidate();

    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
    expect(chargeOnceForGeneration.mock.calls[0]?.[0]).toBe(
      `consolidate:${CONVERSATION}:7`,
    );
    expect(chargeOnceForGeneration.mock.calls[0]?.[1]).toMatchObject({
      projectId: PROJECT,
      actorUserId: USER,
      // What it costs, by the one rate every token-priced call uses. Left
      // unasserted, a charge of zero — or of the token count itself — passes.
      tokensUsed: GOOD_ANSWER.usage.totalTokens,
      amount: creditsForTokens(GOOD_ANSWER.usage.totalTokens),
    });
  });

  it("leaves the retrying to the call that already retries", async () => {
    // `generateTextRetry` is handed `llm_max_retries`, so one original and
    // two retries happen inside it. A loop here would make it nine.
    await consolidate();

    expect(generateTextRetry).toHaveBeenCalledTimes(1);
  });
});

describe("a consolidation that fails", () => {
  it("discards the window when the model call never succeeds", async () => {
    generateTextRetry.mockRejectedValue(new Error("502 upstream"));

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(discardConsolidation).toHaveBeenCalledWith(CONVERSATION, 19);
    expect(logger.error).toHaveBeenCalled();
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
  });

  it("discards the window when the answer is not the JSON it asked for", async () => {
    generateTextRetry.mockResolvedValue({
      text: "Sure! Here is a summary.",
      usage: { totalTokens: 400 },
    });

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(discardConsolidation).toHaveBeenCalledWith(CONVERSATION, 19);
    expect(logger.error).toHaveBeenCalled();
    // T3: the call ran and the tokens went, so the studio is charged for it.
    // Charging only on the way out of a successful write would make every
    // ending but one a free model call.
    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
  });

  it("discards the window when the write fails", async () => {
    commitConsolidation.mockRejectedValue(new Error("deadlock detected"));

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    expect(discardConsolidation).toHaveBeenCalledWith(CONVERSATION, 19);
    expect(logger.error).toHaveBeenCalled();
    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
  });

  it("keeps the window when the memory it reads first cannot be read", async () => {
    // Nothing ran and nothing was spent: the model was never called and the
    // window is whole. Discarding here would throw away turns over a database
    // that was briefly unreachable, and the next turn folds the same window.
    // N4 is still met — the reply goes out either way.
    buildContext.mockRejectedValueOnce(
      new Error("connection terminated unexpectedly"),
    );

    const outcome = await consolidate();

    expect(outcome).toBe("untouched");
    expect(generateTextRetry).not.toHaveBeenCalled();
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(discardConsolidation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("does not log a discard it did not manage to perform", async () => {
    // The line says the window is gone. Written before the write that makes
    // it true, it says so on the one path where the window is still there.
    generateTextRetry.mockRejectedValue(new Error("502 upstream"));
    discardConsolidation.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await consolidate();

    const said = vi.mocked(logger.error).mock.calls.map((call) => call[1]);
    expect(said).toContain("memory_consolidation_discard_failed");
    // The other line says what became of the window, and this path never
    // found out: the discard threw before the watermark moved.
    expect(said).not.toContain("memory_consolidation_failed");
  });

  it("does not call the window lost when another tab had already folded it", async () => {
    // Two tabs over the budget take the same window. One folds it and moves
    // the watermark; the other's model answers with something unreadable and
    // goes to discard turns that are no longer in the history. The write
    // matches no row, and the window it was going to lose is safely folded.
    generateTextRetry.mockResolvedValue({ text: "not json at all", usage: { totalTokens: 10 } });
    discardConsolidation.mockResolvedValue(false);

    const outcome = await consolidate();

    expect(outcome).toBe("superseded");
    // The fold still failed, and that error is the only account of why. What
    // separates the two endings is the field, not whether anything is said.
    const [ctx, message] = vi.mocked(logger.error).mock.calls.at(-1) ?? [];
    expect(message).toBe("memory_consolidation_failed");
    expect(ctx).toMatchObject({ windowLost: false });
  });

  it("says the window went when nobody else had taken it", async () => {
    generateTextRetry.mockResolvedValue({ text: "not json at all", usage: { totalTokens: 10 } });
    discardConsolidation.mockResolvedValue(true);

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    const [ctx, message] = vi.mocked(logger.error).mock.calls.at(-1) ?? [];
    expect(message).toBe("memory_consolidation_failed");
    expect(ctx).toMatchObject({ windowLost: true });
  });

  it("says the watermark stayed put when the window cannot even be discarded", async () => {
    // The discard is itself a write, and whatever failed above is often the
    // reason it fails too. Reporting `discarded` here would be claiming a
    // watermark that never moved, and the caller reassembles for nothing.
    generateTextRetry.mockRejectedValue(new Error("502 upstream"));
    discardConsolidation.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const outcome = await consolidate();

    expect(outcome).toBe("untouched");
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("a consolidation the reader did not wait for", () => {
  it("does nothing at all once the signal is raised", async () => {
    // N7: the reader pressed stop or the page went. This is a model call of
    // its own with a bill attached, and nobody is there to read what it
    // produces.
    const controller = new AbortController();
    controller.abort();

    const outcome = await consolidate({ signal: controller.signal });

    expect(outcome).toBe("aborted");
    expect(generateTextRetry).not.toHaveBeenCalled();
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(discardConsolidation).not.toHaveBeenCalled();
  });

  it("hands the signal to the model call so a stop mid-flight lands", async () => {
    const controller = new AbortController();

    await consolidate({ signal: controller.signal });

    const call = generateTextRetry.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal).toBe(controller.signal);
  });
});

describe("a reader who left while the model was running", () => {
  // N7. The pre-flight check catches a reader who left before the call
  // started; this is the one who left during it, which is the likelier half —
  // the call is seconds long and the panel is showing a line about it.
  // Discarding here would lose turns that are in neither the history nor the
  // memory.
  it("keeps the window, and says so by the signal rather than by a name", async () => {
    // What the provider throws on cancellation is a name, and names differ:
    // the SDK checks three of them and one of the three is a timeout, which
    // is not a reader leaving at all. The signal is the fact itself.
    const controller = new AbortController();
    generateTextRetry.mockImplementation(async () => {
      controller.abort();
      throw new Error("socket hang up");
    });

    const outcome = await consolidate({ signal: controller.signal });

    expect(outcome).toBe("aborted");
    expect(discardConsolidation).not.toHaveBeenCalled();
    expect(commitConsolidation).not.toHaveBeenCalled();
  });
});

describe("a consolidation whose bill could not be settled", () => {
  it("still counts as written, and says so in the log", async () => {
    // The call has already happened and the tokens are already gone, so the
    // charge is the only part of this that failed. Letting it take the turn
    // down would fail a reply that has nothing wrong with it, over
    // bookkeeping the reader never sees — and the write that follows it
    // still lands.
    chargeOnceForGeneration.mockRejectedValue(new Error("redis is down"));

    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("two tabs that consolidated the same conversation", () => {
  it("keeps the memory that covers the further watermark", async () => {
    // N8: the transaction refuses to move the watermark backwards, so the
    // narrower window's write never lands. Its caller reassembles.
    commitConsolidation.mockResolvedValue("superseded");

    const outcome = await consolidate();

    expect(outcome).toBe("superseded");
    expect(discardConsolidation).not.toHaveBeenCalled();
  });

  it("still bills, and the key is what stops the second charge", async () => {
    commitConsolidation.mockResolvedValue("superseded");

    await consolidate();

    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
    expect(chargeOnceForGeneration.mock.calls[0]?.[0]).toBe(
      `consolidate:${CONVERSATION}:7`,
    );
  });
});
