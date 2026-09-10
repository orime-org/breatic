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

const understandMediaAtMock = vi.fn();

vi.mock("@domain/understand/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof understandModule>();
  return {
    ...actual,
    understandMediaAt: (...args: unknown[]) => understandMediaAtMock(...args),
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

const { getAgentConfig } = await import("@breatic/core");
const { AUDIO_FORMAT_NAMES, IMAGE_FORMAT_NAMES, MediaUnavailable, UnderstandRefused, VIDEO_FORMAT_NAMES } =
  await import("@domain/understand/index.js");
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
  understandMediaAtMock.mockReset();
  apiKey = "test-key";
  understandMediaAtMock.mockResolvedValue({
    text: "A black Labrador retriever.",
    finishReason: "stop",
    usage: { totalTokens: 42 },
    kind: "image",
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

  // The whole request rather than the three fixed names, because every field
  // here is one the tool alone decides: what the model asked for reaches the
  // layer underneath unaltered, and each of the five dials goes to the
  // parameter it names. The five carry different values, so a pair swapped
  // between them shows up as a wrong number rather than as nothing at all.
  it("hands down what the model asked for, and each dial where it belongs", async () => {
    const config = getAgentConfig();

    await run({ url: "https://example.com/dog.jpg", question: "What is this?" });

    expect(understandMediaAtMock).toHaveBeenCalledWith({
      url: "https://example.com/dog.jpg",
      question: "What is this?",
      maxBytes: config.understand_media_max_bytes,
      fetchTimeoutMs: config.understand_media_fetch_timeout_ms,
      minBytesPerSec: config.understand_media_min_bytes_per_sec,
      readFloorMs: config.understand_media_read_floor_ms,
      timeoutMs: config.understand_media_call_timeout_ms,
      maxOutputTokens: config.understand_media_max_output_tokens,
      model: "google/gemini-3.8-flash",
      backend: "google-vertex",
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("says the answer was cut short, and keeps what there was", async () => {
    understandMediaAtMock.mockResolvedValue({
      text: "The clip opens on a",
      finishReason: "length",
      usage: { totalTokens: 42 },
      kind: "video",
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
    understandMediaAtMock.mockResolvedValue({
      text: "",
      finishReason: "content_filter",
      usage: { totalTokens: 0 },
      kind: "video",
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
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("too-large", { bytes: 26_000_000, limit: 20_000_000 }),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/big.mp4", question: "What is this?" }),
    );

    expect(forModel).toContain("26000000");
    expect(forModel).toContain("20000000");
    expect(readerKey).toBe("chat.tool.failure.generic");
    
  });

  it("names the type it saw when the address is not media", async () => {
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("unsupported-type", { declaredType: "application/pdf" }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/report.pdf", question: "What is this?" }),
    );

    expect(forModel).toContain("application/pdf");
    
  });

  it("says the address could not be had, with what the layer underneath said", async () => {
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("unreachable", { status: 404, detail: "Not Found" }),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/gone.mp4", question: "What is this?" }),
    );

    expect(forModel).toContain("404");
    expect(readerKey).toBe("chat.tool.failure.unreachable");
  });

  it("says the download ran out of time", async () => {
    understandMediaAtMock.mockRejectedValue(new MediaUnavailable("slow", { detail: "TimeoutError" }));

    const { forModel } = await failureOf(
      run({ url: "https://example.com/slow.mp4", question: "What is this?" }),
    );

    expect(forModel.toLowerCase()).toContain("too long");
  });
});

describe("understand_media — a call the service refused", () => {
  it("tells the model to stop sending a file the service will not take", async () => {
    understandMediaAtMock.mockRejectedValue(
      new UnderstandRefused(413, "Request body exceeds the provider maximum size", "media"),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/clip.mp4", question: "What is this?" }),
    );

    expect(forModel).toContain("exceeds the provider maximum size");
    // The move as well as the words: this is the one kind where sending the
    // same file again reaches the same answer.
    expect(forModel).toContain("do not send the same file again");
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });

  it("leaves a question the model may reword as one worth rewording", async () => {
    // Measured: the same audio asked to be transcribed word for word comes
    // back blocked, and asked what is being said comes back answered. The move
    // that clears it is another question about the same file, so a sentence
    // forbidding that file takes away the only move there was.
    understandMediaAtMock.mockRejectedValue(
      new UnderstandRefused(200, "Gemini blocked the request: SAFETY", "content-filter"),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/talk.mp3", question: "Transcribe this word for word." }),
    );

    expect(forModel).toContain("SAFETY");
    expect(forModel.toLowerCase()).toContain("asking differently");
    expect(forModel).not.toMatch(/do not send/i);
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });

  it("says nothing about the user's file when the failure is ours", async () => {
    // A spent credit, a credential, a model id no longer served. Told the
    // service would not take this media, the model passes on an accusation
    // about a file that was never looked at.
    understandMediaAtMock.mockRejectedValue(
      new UnderstandRefused(402, "This request requires more credits", "deployment"),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/talk.mp3", question: "What is this?" }),
    );

    expect(forModel).not.toMatch(/would not take|do not send|this media|this file/i);
    expect(forModel.toLowerCase()).toContain("not available");
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });

  it("does not call a missing answer a refusal by the model", async () => {
    // Rate limiting, a gateway's error page, a body that stopped part way:
    // none of them is the model declining, and the two point the model at
    // opposite next moves. Told it was refused, it asks differently or tells
    // the user this media cannot be looked at; told nothing came back, it
    // tries again.
    understandMediaAtMock.mockRejectedValue(
      new UnderstandRefused(429, "Rate limit exceeded", "transient"),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/talk.mp3", question: "What is this?" }),
    );

    expect(forModel).not.toMatch(/would not take|do not send/i);
    expect(forModel.toLowerCase()).toContain("again");
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });
});

describe("understand_media — stopping", () => {
  it("reports the turn ending rather than a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    understandMediaAtMock.mockRejectedValue(
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

    expect(understandMediaAtMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("understand_media — saying only what was measured", () => {
  // The size failure comes in two shapes and only one of them carries a
  // figure: a server that states its length is refused on that statement, and
  // a server that states nothing is cut off while the bytes arrive — at which
  // point what is known is "more than the limit came", not how much.
  it("gives the size when the size was stated", async () => {
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("too-large", { bytes: 26_000_000, limit: 20_000_000 }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/big.mp4", question: "What is this?" }),
    );

    expect(forModel).toContain("26000000");
    expect(forModel).toContain("20000000");
  });

  it("states the limit alone when the size was never stated", async () => {
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("too-large", { limit: 20_000_000 }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/chunked.mp4", question: "What is this?" }),
    );

    expect(forModel).toContain("20000000");
    expect(forModel).not.toContain("undefined");
  });

  it("names no byte count for a download that ran out of time", async () => {
    // Nothing counted them: the read gives up on a budget, and how much had
    // arrived is not something this side comes away with.
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("slow", { detail: "TimeoutError" }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/slow.mp4", question: "What is this?" }),
    );

    expect(forModel.toLowerCase()).toContain("too long");
    expect(forModel).not.toMatch(/\d+ bytes/);
  });
});

describe("understand_media — naming the real reason", () => {
  // Audio this endpoint will not take is refused with the same kind as
  // "not media at all", because both mean the address cannot be carried. The
  // sentence cannot be the same: "that is not audio" is false about a voice
  // memo, and it leaves the model with no move — while "this model takes mp3
  // and wav" is something it can pass on as an action.
  it.each([
    ["an m4a", "audio/mp4"],
    ["an ogg", "audio/ogg"],
    ["a flac", "audio/flac"],
  ])("tells the model %s is audio it cannot be sent", async (_name, type) => {
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("unsupported-type", { declaredType: type }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/memo", question: "What is said?" }),
    );

    expect(forModel).toContain(type);
    // Derived rather than spelled out here: the table in types.ts is the only
    // statement of which audio can be sent, and a second copy of the list
    // would go on saying "mp3 and wav" the day a third one is added.
    expect(forModel).toContain(`It takes ${AUDIO_FORMAT_NAMES}.`);
    expect(AUDIO_FORMAT_NAMES).toBe("mp3 and wav");
    expect(forModel).not.toMatch(/not an image, a video or audio/i);
  });

  it("says neither the server nor the name settled a type, and names no format", async () => {
    // Reachable: a host that declines the HEAD, a GET that declares nothing and
    // an address with no extension leave the type unsettled, and the refusal
    // travels without one. Every other branch here names formats to convert
    // to; this one cannot, because nothing is known about what is there, and
    // telling the model to convert an unknown thing to mp3 is a guess it would
    // pass on to the user as fact.
    understandMediaAtMock.mockRejectedValue(new MediaUnavailable("unsupported-type", {}));

    const { forModel } = await failureOf(
      run({ url: "https://example.com/object", question: "What is this?" }),
    );

    expect(forModel).toContain("does not say what it holds");
    expect(forModel).not.toMatch(/It takes|convert/i);
    expect(forModel).not.toContain("undefined");
  });

  it("tells the model a video format it cannot be sent is video", async () => {
    // The same shape as the audio case above, and for the same reason: an avi
    // is a video, so saying it is not one is false and leaves the model with
    // nothing to pass on.
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("unsupported-type", { declaredType: "video/x-msvideo" }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/clip.avi", question: "What happens here?" }),
    );

    expect(forModel).toContain("video/x-msvideo");
    expect(forModel).toContain(`It takes ${VIDEO_FORMAT_NAMES}.`);
    // Names a reader can act on. The endpoint's own word for a .mov is
    // `video/mov`, which is not a type any converter knows; and the audio
    // sentence two branches over says mp3 and wav, so a list of MIME types
    // here would be two vocabularies for one reader.
    expect(VIDEO_FORMAT_NAMES).toBe("mp4, mpeg, webm and mov");
    expect(forModel).not.toMatch(/not an image, a video or audio/i);
  });

  it("tells the model an image format it cannot be sent is an image", async () => {
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("unsupported-type", { declaredType: "image/svg+xml" }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/diagram.svg", question: "What does it show?" }),
    );

    expect(forModel).toContain("image/svg+xml");
    expect(forModel).toContain(`It takes ${IMAGE_FORMAT_NAMES}.`);
    expect(IMAGE_FORMAT_NAMES).toBe("png, jpeg, webp and gif");
    expect(forModel).not.toMatch(/not an image, a video or audio/i);
  });

  it("still says a pdf is not media", async () => {
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("unsupported-type", { declaredType: "application/pdf" }),
    );

    const { forModel } = await failureOf(
      run({ url: "https://example.com/report.pdf", question: "What is this?" }),
    );

    expect(forModel).toMatch(/not an image, a video or audio/i);
  });
});

describe("understand_media — naming which side failed", () => {
  it("says the service did not answer when our own call is what failed", async () => {
    // Everything about the address arrives as MediaUnavailable, so this branch
    // is reached only by the model call. Reporting it as the address being
    // unreadable sends the model to blame a url that was fine, and it puts the
    // vendor endpoint into the conversation on its way to the reader.
    understandMediaAtMock.mockRejectedValue(
      new Error("http request to https://openrouter.ai/api/v1/chat/completions timed out"),
    );

    const { forModel, readerKey } = await failureOf(
      run({ url: "https://example.com/dog.jpg", question: "What is this?" }),
    );

    expect(forModel).not.toContain("openrouter");
    expect(forModel).not.toMatch(/that address/i);
    expect(readerKey).toBe("chat.tool.failure.upstream");
  });

  it("says an empty file is empty, rather than that the address could not be reached", async () => {
    // The address answered: a HEAD, a GET, a content-type. What it holds is
    // nothing. Telling the model it could not be reached sends the user to
    // check an address that is fine, and the sentence contradicts itself in
    // the same breath.
    understandMediaAtMock.mockRejectedValue(new MediaUnavailable("empty", {}));

    const { forModel } = await failureOf(
      run({ url: "https://example.com/clip.mp4", question: "What is this?" }),
    );

    expect(forModel).not.toMatch(/could not be reached/i);
    expect(forModel.toLowerCase()).toContain("empty");
  });

  it("passes on that an address is not one we go to", async () => {
    // What the gate produces, verbatim: it refuses before a byte is sent, so
    // there is no status to report and the reason is the refusal itself. What
    // is listening there stays unsaid; that we declined to go does not.
    understandMediaAtMock.mockRejectedValue(
      new MediaUnavailable("unreachable", { detail: "it is not a public address" }),
    );

    const { forModel } = await failureOf(
      run({ url: "http://192.168.1.1/cam.jpg", question: "What is this?" }),
    );

    expect(forModel).not.toContain("no answer");
    expect(forModel.toLowerCase()).toContain("public");
  });
});
