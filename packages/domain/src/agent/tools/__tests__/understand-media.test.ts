// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What `understand_media` hands back to the model, in each of the ways one
 * call can end.
 *
 * The layer underneath reports and does not interpret: it returns whatever
 * `finish_reason` came back, and throws only when nothing usable did. Turning
 * those into sentences is this file's subject, and every sentence is aimed at
 * the model rather than at a reader — a reader sees one of four coarse lines,
 * and which of them is pinned here too.
 *
 * The three registrations are pinned because a tool reaches a turn by being in
 * all three: absent from the map it does not exist, absent from the baseline
 * no caller receives it, and absent from the requirements it is offered on a
 * deployment where it cannot work.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { toolFailureOf } from "@breatic/shared";
import type * as coreModule from "@breatic/core";
import type * as understandModule from "@domain/understand/index.js";

const understandMediaMock = vi.fn();
const fetchMediaMock = vi.fn();

vi.mock("@domain/understand/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof understandModule>();
  return {
    ...actual,
    understandMedia: (...args: unknown[]) => understandMediaMock(...args),
    fetchMedia: (...args: unknown[]) => fetchMediaMock(...args),
  };
});

let apiKey = "test-key";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getRawEnvVar: (name: string) => (name === "OPENROUTER_API_KEY" ? apiKey : undefined),
    env: new Proxy(
      {},
      { get: (_t, prop: string) => (prop === "OPENROUTER_API_KEY" ? apiKey : undefined) },
    ),
  };
});

const { MediaUnavailable, UnderstandRefused } = await import("@domain/understand/index.js");
const { TOOL_MAP, BASELINE_TOOLS, buildToolSet } = await import("@domain/agent/tools/index.js");

/**
 * Run the tool the way a turn runs it.
 * @param input - What the model asked for.
 * @param signal - The turn's signal, when there is one.
 * @returns Whatever the tool answered with.
 * @throws {Error} whatever the tool threw.
 */
async function run(
  input: { url: string; question: string },
  signal?: AbortSignal,
): Promise<unknown> {
  const build = TOOL_MAP.understand_media;
  if (!build) throw new Error("understand_media is not registered");
  const execute = build().execute;
  if (!execute) throw new Error("understand_media has no execute");
  return execute(input, {
    toolCallId: "call-1",
    messages: [],
    ...(signal ? { abortSignal: signal } : {}),
  } as never);
}

/**
 * The reason a failed call put in front of the model.
 * @param call - The call to await.
 * @returns The model-facing reason and the reader's line.
 */
async function failureOf(call: Promise<unknown>): Promise<{
  forModel: string;
  readerKey: string;
}> {
  try {
    await call;
  } catch (err) {
    const failure = toolFailureOf(err);
    if (!failure) throw new Error(`not a tool failure: ${String(err)}`);
    return { forModel: failure.forModel, readerKey: failure.readerKey };
  }
  throw new Error("the call did not fail");
}

beforeEach(() => {
  understandMediaMock.mockReset();
  fetchMediaMock.mockReset();
  apiKey = "test-key";
  fetchMediaMock.mockResolvedValue({
    kind: "image",
    url: "https://example.com/dog.jpg",
    mediaType: "image/jpeg",
  });
  understandMediaMock.mockResolvedValue({
    text: "A black Labrador retriever.",
    finishReason: "stop",
    usage: { totalTokens: 42 },
  });
});

describe("understand_media — reaching a turn at all", () => {
  it("is in the registry", () => {
    expect(TOOL_MAP).toHaveProperty("understand_media");
  });

  it("is one of the tools a caller gets without asking", () => {
    expect(BASELINE_TOOLS).toContain("understand_media");
  });

  // One assertion rather than two, because "absent without a key" is true of
  // every name that was never registered: on its own it would pass against a
  // tool that does not exist. What the requirement entry buys is the
  // difference between the two sets, so the difference is what is pinned.
  it("is offered where the key is set and left out where it is not", () => {
    apiKey = "test-key";
    expect(Object.keys(buildToolSet(["understand_media"]))).toContain("understand_media");

    apiKey = "";
    expect(Object.keys(buildToolSet(["understand_media"]))).not.toContain("understand_media");
  });
});

describe("understand_media — a call that worked", () => {
  it("hands the model the answer", async () => {
    const answer = await run({
      url: "https://example.com/dog.jpg",
      question: "What is this?",
    });

    expect(answer).toBe("A black Labrador retriever.");
  });

  it("pins the model and the backend on the way down", async () => {
    await run({ url: "https://example.com/dog.jpg", question: "What is this?" });

    expect(understandMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "google/gemini-3.8-flash",
        backend: "google-vertex",
        apiKey: "test-key",
      }),
    );
  });

  it("says the answer was cut short, and keeps what there was", async () => {
    understandMediaMock.mockResolvedValue({
      text: "The clip opens on a",
      finishReason: "length",
      usage: { totalTokens: 42 },
    });

    const answer = (await run({
      url: "https://example.com/clip.mp4",
      question: "What happens?",
    })) as string;

    expect(answer).toContain("The clip opens on a");
    expect(answer.toLowerCase()).toContain("cut off");
  });
});

describe("understand_media — a call that came back with nothing", () => {
  it("tells the model the answer was empty, and that rewording may help", async () => {
    understandMediaMock.mockResolvedValue({
      text: "",
      finishReason: "content_filter",
      usage: { totalTokens: 0 },
    });

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/talk.mp3", question: "Transcribe this word for word." }),
    );

    expect(forModel).toContain("content_filter");
    expect(forModel.toLowerCase()).toContain("differently");
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });
});

describe("understand_media — a call that never reached the model", () => {
  it("passes on the size and the limit when the file is too big", async () => {
    fetchMediaMock.mockRejectedValue(
      new MediaUnavailable("too-large", { bytes: 26_000_000, limit: 20_000_000 }),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/big.mp4", question: "What is this?" }),
    );

    expect(forModel).toContain("26000000");
    expect(forModel).toContain("20000000");
    expect(readerKey).toBe("chat.tool.failure.generic");
    expect(understandMediaMock).not.toHaveBeenCalled();
  });

  it("names the type it saw when the address is not media", async () => {
    fetchMediaMock.mockRejectedValue(
      new MediaUnavailable("unsupported-type", { declaredType: "application/pdf" }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/report.pdf", question: "What is this?" }),
    );

    expect(forModel).toContain("application/pdf");
    expect(understandMediaMock).not.toHaveBeenCalled();
  });

  it("says the address could not be had, with what the layer underneath said", async () => {
    fetchMediaMock.mockRejectedValue(
      new MediaUnavailable("unreachable", { status: 404, detail: "Not Found" }),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/gone.mp4", question: "What is this?" }),
    );

    expect(forModel).toContain("404");
    expect(readerKey).toBe("chat.tool.failure.unreachable");
  });

  it("says the download ran out of time", async () => {
    fetchMediaMock.mockRejectedValue(new MediaUnavailable("slow", { bytes: 900 }));

    const { forModel } = await failureOf(
      run({ url: "https://example.com/slow.mp4", question: "What is this?" }),
    );

    expect(forModel.toLowerCase()).toContain("too long");
  });
});

describe("understand_media — a call the service refused", () => {
  it("passes the service's own words to the model", async () => {
    understandMediaMock.mockRejectedValue(
      new UnderstandRefused(200, "Gemini blocked the request: SAFETY"),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/talk.mp3", question: "Transcribe this word for word." }),
    );

    expect(forModel).toContain("SAFETY");
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });
});

describe("understand_media — stopping", () => {
  it("reports the turn ending rather than a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMediaMock.mockRejectedValue(
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    );

    const { readerKey } = await failureOf(
      run({ url: "https://example.com/dog.jpg", question: "What is this?" }, controller.signal),
    );

    expect(readerKey).toBe("chat.tool.unfinished");
  });

  it("passes the turn's signal all the way down", async () => {
    const controller = new AbortController();
    await run({ url: "https://example.com/dog.jpg", question: "What is this?" }, controller.signal);

    expect(fetchMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(understandMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
