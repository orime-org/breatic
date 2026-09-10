// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What `understandMedia` sends, and what it makes of what comes back.
 *
 * The request body is pinned part by part because each of the three shapes was
 * measured against the live endpoint and none of them is interchangeable: an
 * image goes as a url, a video as a data uri under `video_url`, and audio as
 * bare base64 with a format beside it. A shape that drifts here is a shape the
 * backend refuses, and nothing between this function and the network would say
 * so.
 *
 * `model` and `provider` are pinned for the same reason from the other end:
 * they are the whole of "pin gemini-3.8-flash on google-vertex", and they are
 * inputs, so a caller that passes something else must reach the wire with it.
 *
 * On the way back, this layer reports and does not interpret: a body that
 * arrived is returned with its `finishReason` whatever that says, and only a
 * refusal throws. Which sentence a reader ends up seeing is the tool's to
 * decide, one layer up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import { understandMedia } from "@domain/understand/understand.js";
import { UnderstandRefused } from "@domain/understand/types.js";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

/** A reply shaped the way the endpoint shapes one. */
function answered(text: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      usage: { total_tokens: 42 },
      provider: "Google",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The inputs every test varies from. */
const base = {
  question: "What is this?",
  model: "google/gemini-3.8-flash",
  backend: "google-vertex",
  apiKey: "test-key",
  baseUrl: "https://openrouter.ai/api/v1",
  maxOutputTokens: 2048,
  timeoutMs: 180_000,
};

/**
 * The body of the one request that was made.
 * @returns The parsed request body.
 * @throws {Error} when no request was made.
 */
function sentBody(): Record<string, unknown> {
  const call = httpRequestMock.mock.calls[0];
  if (!call) throw new Error("no request was made");
  return JSON.parse((call[1] as RequestInit).body as string);
}

/**
 * The single content part beside the question in the one request made.
 * @returns The media part of the user message.
 */
function sentMediaPart(): Record<string, unknown> {
  const messages = sentBody().messages as Array<{ content: Array<Record<string, unknown>> }>;
  const parts = messages[0]?.content ?? [];
  const last = parts[parts.length - 1];
  if (!last) throw new Error("the request carried no media part");
  return last;
}

beforeEach(() => {
  httpRequestMock.mockReset();
  httpRequestMock.mockResolvedValue(answered("a puppy"));
});

describe("understandMedia — the three media shapes", () => {
  it("sends an image as a url the backend fetches itself", async () => {
    await understandMedia({
      ...base,
      media: { kind: "image", url: "https://example.com/dog.jpg" },
    });

    expect(sentMediaPart()).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/dog.jpg" },
    });
  });

  it("sends a video as a data uri carrying its bytes", async () => {
    await understandMedia({
      ...base,
      media: {
        kind: "video",
        bytes: new Uint8Array([0, 1, 2, 3]),
        format: "video/mp4",
      },
    });

    expect(sentMediaPart()).toEqual({
      type: "video_url",
      video_url: { url: `data:video/mp4;base64,${Buffer.from([0, 1, 2, 3]).toString("base64")}` },
    });
  });

  it("sends audio as bare base64 with the format beside it", async () => {
    // The format arrives already settled — which audio this endpoint takes is
    // decided where the address is, so `fetch-media` owns that table and its
    // own cases pin it. What is pinned here is that the name travels through
    // to the wire rather than being derived again from the type.
    await understandMedia({
      ...base,
      media: {
        kind: "audio",
        bytes: new Uint8Array([4, 5, 6]),
        format: "wav",
      },
    });

    expect(sentMediaPart()).toEqual({
      type: "input_audio",
      input_audio: {
        data: Buffer.from([4, 5, 6]).toString("base64"),
        format: "wav",
      },
    });
  });

  it("puts the question ahead of the media", async () => {
    await understandMedia({
      ...base,
      question: "How long is this clip?",
      media: { kind: "image", url: "https://example.com/a.png" },
    });

    const messages = sentBody().messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]).toEqual({ type: "text", text: "How long is this clip?" });
  });
});

describe("understandMedia — what pins the backend", () => {
  it("names the model and pins the backend with fallbacks off", async () => {
    await understandMedia({
      ...base,
      media: { kind: "image", url: "https://example.com/a.png" },
    });

    const body = sentBody();
    expect(body.model).toBe("google/gemini-3.8-flash");
    expect(body.provider).toEqual({ only: ["google-vertex"], allow_fallbacks: false });
    expect(body.max_tokens).toBe(2048);
  });

  it("omits the provider field entirely when no backend is asked for", async () => {
    await understandMedia({
      ...base,
      backend: undefined,
      media: { kind: "image", url: "https://example.com/a.png" },
    });

    expect(sentBody()).not.toHaveProperty("provider");
  });

  it("carries the caller's model, backend, key and address rather than any of its own", async () => {
    await understandMedia({
      ...base,
      model: "some/other-model",
      backend: "some-other-backend",
      apiKey: "another-key",
      baseUrl: "https://example.invalid/v9",
      maxOutputTokens: 64,
      media: { kind: "image", url: "https://example.com/a.png" },
    });

    const [url, init] = httpRequestMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.invalid/v9/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer another-key");

    const body = sentBody();
    expect(body.model).toBe("some/other-model");
    expect(body.provider).toEqual({ only: ["some-other-backend"], allow_fallbacks: false });
    expect(body.max_tokens).toBe(64);
  });
});

describe("understandMedia — what it tells the transport", () => {
  it("declares the call unsafe to replay and passes the caller's budget", async () => {
    await understandMedia({
      ...base,
      timeoutMs: 90_000,
      media: { kind: "video", bytes: new Uint8Array([1]), format: "video/mp4" },
    });

    const options = httpRequestMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.replaySafe).toBe(false);
    expect(options.timeoutMs).toBe(90_000);
  });

  it("passes the caller's signal through", async () => {
    const controller = new AbortController();
    await understandMedia({
      ...base,
      signal: controller.signal,
      media: { kind: "image", url: "https://example.com/a.png" },
    });

    const options = httpRequestMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.signal).toBe(controller.signal);
  });
});

describe("understandMedia — what comes back", () => {
  it("returns the text with the reason the model stopped", async () => {
    httpRequestMock.mockResolvedValue(answered("A black Labrador retriever."));

    const result = await understandMedia({
      ...base,
      media: { kind: "image", url: "https://example.com/dog.jpg" },
    });

    expect(result.text).toBe("A black Labrador retriever.");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.totalTokens).toBe(42);
  });

  it("returns a truncated answer as it came, saying it was cut off", async () => {
    httpRequestMock.mockResolvedValue(answered("The clip opens on a", "length"));

    const result = await understandMedia({
      ...base,
      media: { kind: "video", bytes: new Uint8Array([1]), format: "video/mp4" },
    });

    expect(result.text).toBe("The clip opens on a");
    expect(result.finishReason).toBe("length");
  });

  it("returns an empty answer as it came, saying what stopped it", async () => {
    httpRequestMock.mockResolvedValue(answered("", "content_filter"));

    const result = await understandMedia({
      ...base,
      media: { kind: "audio", bytes: new Uint8Array([1]), format: "mp3" },
    });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("content_filter");
  });

  it("throws with the status and the service's own words when the call is refused", async () => {
    httpRequestMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              "Request body exceeds the provider maximum size: 109146174 bytes exceeds the " +
              "100000000 byte limit for Google",
          },
        }),
        { status: 413, headers: { "content-type": "application/json" } },
      ),
    );

    const call = understandMedia({
      ...base,
      media: { kind: "video", bytes: new Uint8Array([1]), format: "video/mp4" },
    });

    await expect(call).rejects.toBeInstanceOf(UnderstandRefused);
    await expect(call).rejects.toMatchObject({
      status: 413,
      detail: expect.stringContaining("100000000 byte limit"),
      // About the media itself: this body is over the ceiling, and the same
      // bytes reach the same ceiling however many times they are sent.
      kind: "media",
    });
  });

  it("throws on a 200 that carries an error, which is a shape this endpoint returns", async () => {
    // Measured: the same audio with "Transcribe what is said, word for word."
    // comes back HTTP 200 with this in the body.
    httpRequestMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Gemini blocked the request: SAFETY" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const call = understandMedia({
      ...base,
      media: { kind: "audio", bytes: new Uint8Array([1]), format: "mp3" },
    });

    await expect(call).rejects.toBeInstanceOf(UnderstandRefused);
    await expect(call).rejects.toMatchObject({
      status: 200,
      detail: expect.stringContaining("SAFETY"),
      // The one shape where the status says nothing: 200 with an error and no
      // code of its own. Measured, it is the model's guardrail, and the move
      // that clears it is a differently worded question about the same file.
      kind: "content-filter",
    });
  });

  it("throws when a 200 carries no choices at all", async () => {
    // A body that parsed, carries no error, and has nothing to read. Letting
    // it through would hand the caller an empty answer that looks like the
    // model chose to say nothing.
    httpRequestMock.mockResolvedValue(
      new Response(JSON.stringify({ usage: { total_tokens: 3 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      understandMedia({
        ...base,
        media: { kind: "image", url: "https://example.com/a.png" },
      }),
      // A 200 that parsed and holds nothing is not something to say about the
      // media, and nothing here shows a second attempt would differ.
    ).rejects.toMatchObject({ name: "UnderstandRefused", kind: "deployment" });
  });

  it("gives up on an answer that arrives slower than the call's budget", async () => {
    // The transport's deadline is spent once it hands the response back, so
    // reading the answer runs under one of its own. Without it an upstream
    // that dribbles bytes holds this call open with nothing to show.
    const dribble = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices"'));
        // and never finishes
      },
    });
    httpRequestMock.mockResolvedValue(new Response(dribble, { status: 200 }));

    await expect(
      understandMedia({
        ...base,
        timeoutMs: 20,
        media: { kind: "image", url: "https://example.com/a.png" },
      }),
      // The headers arrived and the body stopped on the way, which is the one
      // failure the status cannot speak for and the kind a retry fixes.
    ).rejects.toMatchObject({ name: "UnderstandRefused", kind: "transient" });
  });

  it("throws when the body is not the shape this endpoint answers with", async () => {
    httpRequestMock.mockResolvedValue(
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(
      understandMedia({
        ...base,
        media: { kind: "image", url: "https://example.com/a.png" },
      }),
    ).rejects.toMatchObject({ name: "UnderstandRefused", kind: "deployment" });
  });

  it("does not send a reader back at a 403, which this service uses for content it will not take", async () => {
    // The service's own words for this status: "insufficient permissions,
    // guardrail block, or moderation flag". Two of the three are content being
    // turned away, and none of the three answers differently on a second
    // attempt — telling a reader to try again shortly sends them at an address
    // that says the same thing every time.
    httpRequestMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Blocked by guardrail" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      understandMedia({
        ...base,
        media: { kind: "image", url: "https://example.com/a.png" },
      }),
    ).rejects.toMatchObject({ status: 403, kind: "content-filter" });
  });

  it("sends a reader back only at the statuses a second attempt could answer differently", async () => {
    // Every failure this endpoint answers with carries the same error envelope
    // — a rate limit, a spent credit, an oversized body — so the envelope says
    // nothing and the status decides. Told to try again at a permanent
    // failure, a reader retries forever.
    for (const status of [408, 429, 500, 502, 503, 504]) {
      httpRequestMock.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: `refused with ${status}` } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );

      await expect(
        understandMedia({
          ...base,
          media: { kind: "image", url: "https://example.com/a.png" },
        }),
      ).rejects.toMatchObject({ status, kind: "transient" });
    }
  });
});

describe("understandMedia — what a refusal is about", () => {
  /**
   * Ask about one image and hand back the refusal.
   * @returns The refusal.
   */
  async function refusalOf(): Promise<UnderstandRefused> {
    return (await understandMedia({
      ...base,
      media: { kind: "image", url: "https://example.com/a.png" },
    }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (err: unknown) => err,
    )) as UnderstandRefused;
  }

  it.each([
    [402, "This request requires more credits"],
    [401, "User not found."],
    [404, "No endpoints found for this model"],
    [418, "something nobody wrote a case for"],
  ])("calls a %i our deployment's problem, never the user's file", async (status, message) => {
    // The account, the credential, a model id that is no longer served, and
    // every code nobody has thought about: none is a statement about the file
    // that was sent. Landing them on the media side tells a user their file was
    // rejected and to stop sending it, which is a false accusation and takes
    // away the only move they had.
    httpRequestMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

    expect((await refusalOf()).kind).toBe("deployment");
  });

  it("calls an edge server's 5xx transient, whatever number it carries", async () => {
    // Measured: this endpoint answers from behind Cloudflare (`server:
    // cloudflare`), which raises 520 through 530 for its own origin troubles
    // and answers them in HTML. The call timeout here is longer than
    // Cloudflare's own origin ceiling, so 524 is the code a large upload and a
    // slow answer arrive at rather than a hypothetical.
    for (const status of [507, 520, 521, 522, 523, 524, 530]) {
      httpRequestMock.mockResolvedValue(
        new Response("<!DOCTYPE html><title>Origin Time-out</title>", { status }),
      );

      expect((await refusalOf()).kind).toBe("transient");
    }
  });

  it("reads the code the error envelope carries, since a 200 does not carry one", async () => {
    // The service's own words: on an error raised while the model is already
    // producing output, "the returned HTTP response status will be 200 OK" and
    // the real code travels in `error.code`. Judging by the transport status
    // there judges a constant.
    httpRequestMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Provider rate limited", code: 429 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const refusal = await refusalOf();
    expect(refusal.kind).toBe("transient");
    expect(refusal.status).toBe(429);
  });

  it("judges an answer with no body by the status it arrived with", async () => {
    // An empty body is not a body that stopped part way. Calling it that puts
    // every permanent failure with nothing in it on the retry side, and the
    // retry re-uploads the whole clip.
    httpRequestMock.mockResolvedValue(new Response(null, { status: 402 }));

    const refusal = await refusalOf();
    expect(refusal.kind).toBe("deployment");
    expect(refusal.detail).not.toContain("never finished arriving");
  });
});

describe("understandMedia — the name a video travels under", () => {
  it("sends quicktime as the name this endpoint lists", async () => {
    // A .mov is served as `video/quicktime` (measured against two hosts), and
    // the endpoint's own list of video types names `video/mov` — it does not
    // list quicktime at all. Passed through, the whole clip is uploaded before
    // that is discovered, which is the cost the audio table exists to avoid.
    await understandMedia({
      ...base,
      media: {
        kind: "video",
        bytes: new Uint8Array([1]),
        format: "video/mov",
      },
    });

    expect(sentMediaPart()).toMatchObject({
      video_url: { url: expect.stringContaining("data:video/mov;base64,") },
    });
  });

  it("sends the other video types unchanged", async () => {
    await understandMedia({
      ...base,
      media: { kind: "video", bytes: new Uint8Array([1]), format: "video/webm" },
    });

    expect(sentMediaPart()).toMatchObject({
      video_url: { url: expect.stringContaining("data:video/webm;base64,") },
    });
  });
});
