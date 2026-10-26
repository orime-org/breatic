// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the canvas's understand task runs (#2175).
 *
 * The capability lives in `@breatic/domain` and the agent's tool calls the
 * same one: getting the media and asking about it is one order of steps with
 * one set of limits, and a second assembly of it here would classify failures
 * its own way. So this path supplies the figures and hands over.
 *
 * What comes back is text, and text is what the node gets. Nothing about this
 * run produces an asset, so nothing here reaches for a URL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import type * as DomainModule from "@breatic/domain";
import type * as CoreModule from "@breatic/core";

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, understandMediaAt: vi.fn() };
});
/**
 * What the deployment's multiplier is worth in these cases.
 *
 * `env` is a Proxy that refuses to be read before `initCore` has run, which
 * a test process never does. One is the schema's own default, so the
 * assertions below read as the plain dollars-to-cents conversion.
 *
 * Hoisted because the factory below is: `vi.mock` is lifted above every
 * import, and a plain `const` read from inside it is read before it exists.
 */
const MULTIPLIER = vi.hoisted(() => 1);

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getRawEnvVar: vi.fn(() => "test-key"),
    env: { CREDIT_MULTIPLIER: MULTIPLIER },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import {
  createUsageRecorder,
  MediaUnavailable,
  UnderstandRefused,
  understandMediaAt,
} from "@breatic/domain";
import type { UsageRecorder, UsageRow } from "@breatic/domain";

import { runUnderstand } from "@worker/handlers/dispatch.js";
import {
  CutShort,
  StoppedPartWay,
  TranscriptionBlocked,
} from "@worker/handlers/understand-failure.js";

const PARAMS = {
  source_type: "image",
  source_url: "https://assets.invalid/image/a.png",
};

/** The rows the run's recorder wrote, and the ones it said lacked a cost. */
let rows: UsageRow[] = [];
let missing: UsageRow[] = [];

/**
 * The real recorder, writing into `rows` instead of the database.
 * @returns A recorder for one task.
 */
function recorder(): UsageRecorder {
  return createUsageRecorder({
    operationKey: "task:t-1",
    feature: "canvas_understand",
    actorUserId: "u-1",
    projectId: "p-1",
    pricing: {
      models: {},
      services: {
        brave_web_search: { per_request: 0.005 },
        brave_image_search: { per_request: 0.005 },
      },
    },
    multiplier: MULTIPLIER,
    write: async (row) => void rows.push(row),
    onMissingCost: (row) => void missing.push(row),
  });
}

/**
 * A capability that reports the call billed, the way the real one does once
 * the answer shows it, and then answers or fails.
 * @param costUsd - What it reports the call cost.
 * @param then - What it does next.
 */
function billedThen(costUsd: number | undefined, then: () => unknown): void {
  vi.mocked(understandMediaAt).mockImplementation((async (request: {
    onBilled: (cost: number | undefined) => void;
  }) => {
    request.onBilled(costUsd);
    return then();
  }) as never);
}

/** When the reading's task runs out. */
const DEADLINE_AT = Date.now() + 3_600_000;

describe("running one understand task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    missing = [];
    vi.mocked(understandMediaAt).mockResolvedValue({
      text: "A red bicycle against a brick wall.",
      finishReason: "stop",
      kind: "image",
      kinds: ["image"],
    });
  });

  // The type the ledger read off the landed bytes travels with the request,
  // because the browser's own format gate judged by it: storage answers for
  // the same address with the type a ticket signed, guessed from a file name.
  // This is the middle of that chain — the end that judges is a package away.
  it("hands over the type the ledger judged, when the press knew it", async () => {
    await runUnderstand({ ...PARAMS, source_mime_type: "image/png" }, recorder(), DEADLINE_AT);

    expect(vi.mocked(understandMediaAt)).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ url: PARAMS.source_url, ledgerType: "image/png" }] }),
    );
  });

  // A node stored before the ledger reported its type carries none, and the
  // run judges by the address the way it did before.
  it("hands over no type when the press had none", async () => {
    await runUnderstand(PARAMS, recorder(), DEADLINE_AT);

    const [args] = vi.mocked(understandMediaAt).mock.calls[0] ?? [];
    expect(args?.items).toEqual([{ url: PARAMS.source_url }]);
  });

  it("hands the address and the ceilings to the shared capability", async () => {
    await runUnderstand(PARAMS, recorder(), DEADLINE_AT);

    // Every figure is what is left of the task (inner#1367).
    const left = DEADLINE_AT - Date.now();
    const [args] = vi.mocked(understandMediaAt).mock.calls[0] ?? [];
    expect(args?.fetchTimeoutMs).toBeLessThanOrEqual(left + 1000);
    expect(args?.fetchTimeoutMs).toBeGreaterThan(left - 5000);
    expect(args?.timeoutMs).toBe(args?.fetchTimeoutMs);
    expect(args?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(understandMediaAt)).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ url: PARAMS.source_url }],
        maxBytes: expect.any(Number),
        maxOutputTokens: expect.any(Number),
        question: expect.any(String),
        model: expect.any(String),
        apiKey: "test-key",
        baseUrl: expect.any(String),
      }),
    );
  });

  it("carries the text back as the content one node gets", async () => {
    const [result] = await runUnderstand(PARAMS, recorder(), DEADLINE_AT);

    expect(result).toMatchObject({
      outputs: [{ content: "A red bicycle against a brick wall." }],
    });
  });

  // An answer of nothing is a run that finished having put nothing on the
  // node. Writing it would replace whatever the reader had with an empty
  // node while the count says the run succeeded.
  it("refuses an empty answer rather than writing it", async () => {
    vi.mocked(understandMediaAt).mockResolvedValue({
      text: "",
      finishReason: "stop",
      kind: "image",
      kinds: ["image"],
    });

    await expect(runUnderstand(PARAMS, recorder(), DEADLINE_AT)).rejects.toThrow();
  });

  // The media was the prompt, so a call that wrote nothing was still paid
  // for. The run fails and charges nothing, and the row says what it cost.
  it("records what an empty answer cost before failing", async () => {
    billedThen(0.0041, () => ({ text: "", finishReason: "content_filter", kind: "image" }));

    await expect(runUnderstand(PARAMS, recorder(), DEADLINE_AT)).rejects.toThrow();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "model", costUsd: 0.0041, costSource: "provider" });
  });

  // The run is gated on credits before it goes out, so it has to be charged
  // after. What it charges is what the service said it took, converted the
  // one way every other transport's cost is: dollars to cents, times the
  // deployment's multiplier.
  it("charges what the service said the call cost", async () => {
    billedThen(0.0037, () => ({ text: "A red bicycle.", finishReason: "stop", kind: "image" }));

    const [, credits] = await runUnderstand(PARAMS, recorder(), DEADLINE_AT);

    expect(credits).toBeCloseTo(0.0037 * 100 * MULTIPLIER, 10);
  });

  // A service that answered without saying what it cost has not said zero.
  // Charging zero would be this path inventing a figure; the run is recorded
  // uncharged and reconciliation is where an unpriced run belongs.
  it("charges nothing when the service did not say what it cost", async () => {
    billedThen(undefined, () => ({ text: "A red bicycle.", finishReason: "stop", kind: "image" }));
    const [, credits] = await runUnderstand(PARAMS, recorder(), DEADLINE_AT);

    expect(credits).toBe(0);
    // Recorded at zero and reported, so reconciliation can find it.
    expect(missing).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costSource: "missing" });
  });

  it("records the call it charged for", async () => {
    billedThen(0.0037, () => ({ text: "A red bicycle.", finishReason: "stop", kind: "image" }));

    await runUnderstand(PARAMS, recorder(), DEADLINE_AT);

    expect(rows).toEqual([
      expect.objectContaining({
        operationKey: "task:t-1",
        feature: "canvas_understand",
        source: "model",
        provider: "openrouter",
        requestCount: 1,
        costUsd: 0.0037,
        costSource: "provider",
      }),
    ]);
  });

  // A refusal the service still billed was money spent. The run fails and
  // charges nothing, but the row is written before the failure goes on.
  it("records a refusal the service billed, then fails with it", async () => {
    billedThen(0.002, () => {
      throw new UnderstandRefused(200, "blocked", "content-filter");
    });

    await expect(runUnderstand(PARAMS, recorder(), DEADLINE_AT)).rejects.toBeInstanceOf(UnderstandRefused);

    expect(rows).toEqual([expect.objectContaining({ costUsd: 0.002, costSource: "provider" })]);
  });

  it("records nothing when the media never reached the service", async () => {
    vi.mocked(understandMediaAt).mockRejectedValue(new MediaUnavailable("too-large", {}));

    await expect(runUnderstand(PARAMS, recorder(), DEADLINE_AT)).rejects.toBeInstanceOf(MediaUnavailable);

    expect(rows).toEqual([]);
  });

  // The words this produces are the node's body, and a reader opens that
  // node in the language they set. Nothing about the media says which that
  // is, so the run is told — and the telling has to reach the model, because
  // the model is what decides the language of the answer.
  it("asks in the language the reader set", async () => {
    await runUnderstand({ ...PARAMS, reader_locale: "zh-CN" }, recorder(), DEADLINE_AT);

    expect(vi.mocked(understandMediaAt)).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining("Simplified Chinese"),
      }),
    );
  });

  // A run that named no locale, and one that named something this build does
  // not know, both reach the model the same way: asking for nothing in
  // particular, which is what every run did before the locale travelled.
  it("asks for no language in particular when none was named", async () => {
    await runUnderstand(PARAMS, recorder(), DEADLINE_AT);
    await runUnderstand({ ...PARAMS, reader_locale: "xx-YY" }, recorder(), DEADLINE_AT);

    for (const call of vi.mocked(understandMediaAt).mock.calls) {
      expect(call[0].question).toBe("Describe this image.");
    }
  });

  // A reader who typed their own question gets asked that question. The
  // language line still rides along: they wrote it in their own language and
  // an answer in another one is not what they asked for.
  it("keeps the reader's own question and still names the language", async () => {
    await runUnderstand(
      {
        ...PARAMS,
        prompt: "How many people are in this?",
        reader_locale: "ja",
      },
      recorder(),
      DEADLINE_AT,
    );

    const asked = vi.mocked(understandMediaAt).mock.calls[0]?.[0].question;
    expect(asked).toContain("How many people are in this?");
    expect(asked).toContain("Japanese");
  });

  it("lets the capability's own failures through as they are", async () => {
    vi.mocked(understandMediaAt).mockRejectedValue(new MediaUnavailable("too-large", {}));

    await expect(runUnderstand(PARAMS, recorder(), DEADLINE_AT)).rejects.toBeInstanceOf(
      MediaUnavailable,
    );
  });
});

// inner#856: a transcription runs the same reading with its own question and
// allowance, and puts nothing on the node unless the model finished.
describe("running one transcription", () => {
  const TRANSCRIBE = {
    source_type: "audio",
    source_url: "https://assets.invalid/audio/a.m4a",
    reading: "transcribe",
    keep_fillers: true,
    reader_locale: "zh-CN",
  };

  /**
   * Answer with this text and stop reason.
   * @param text - What the model wrote.
   * @param finishReason - Why it stopped.
   */
  function answers(text: string, finishReason: string): void {
    vi.mocked(understandMediaAt).mockResolvedValue({ text, finishReason, kind: "audio", kinds: ["audio"] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    missing = [];
    answers("大家好。\n你好。", "stop");
  });

  it("asks the transcription question with its own allowance", async () => {
    await runUnderstand(TRANSCRIBE, recorder(), DEADLINE_AT);

    const [args] = vi.mocked(understandMediaAt).mock.calls[0] ?? [];
    expect(args?.question).toContain("Transcribe the speech in this audio.");
    expect(args?.question).toContain("Simplified Chinese");
    expect(args?.question).toContain("Keep filler words");
    expect(args?.question).not.toMatch(/Answer in/);
    expect(args?.maxOutputTokens).toBe(65_536);
  });

  it("puts a finished transcript on the node", async () => {
    const [result] = await runUnderstand(TRANSCRIBE, recorder(), DEADLINE_AT);
    expect(result).toMatchObject({ outputs: [{ content: "大家好。\n你好。" }] });
  });

  describe.each(["audio", "video"])("normal %s responses", (sourceType) => {
    it.each([
      "The meeting starts now.\nPlease take a seat.",
      "  NO_SPEECH\n",
      "No one speaks in this recording.",
      "An incorrect transcript.",
      "",
    ])("preserves %j and settles the reported cost", async (text) => {
      billedThen(0.0037, () => ({ text, finishReason: "stop", kind: sourceType }));

      const [result, credits] = await runUnderstand(
        { ...TRANSCRIBE, source_type: sourceType }, recorder(), DEADLINE_AT,
      );

      expect(result).toEqual({ outputs: [{ content: text }], finish_reason: "stop" });
      expect(credits).toBeCloseTo(0.37, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ costUsd: 0.0037, costSource: "provider" });
      expect(missing).toEqual([]);
    });
  });

  it("preserves arbitrary normal text independently of the reported charge", async () => {
    await fc.assert(fc.asyncProperty(
      fc.oneof(fc.string(), fc.constant(""), fc.constant("NO_SPEECH")),
      fc.integer({ min: 0, max: 10_000 }),
      async (text, creditCents) => {
        rows = [];
        const costUsd = creditCents / 10_000;
        billedThen(costUsd, () => ({ text, finishReason: "stop", kind: "audio" }));
        const [result, credits] = await runUnderstand(TRANSCRIBE, recorder(), DEADLINE_AT);
        expect(result).toEqual({ outputs: [{ content: text }], finish_reason: "stop" });
        expect(credits).toBeCloseTo(creditCents / 100, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ costUsd, costSource: "provider" });
      },
    ));
  });

  it.each([
    ["length", CutShort],
    ["content_filter", TranscriptionBlocked],
    ["error", StoppedPartWay],
  ])("puts nothing on the node when it stopped for %s part way", async (reason, kind) => {
    answers("The first half of what was", reason);
    await expect(runUnderstand(TRANSCRIBE, recorder(), DEADLINE_AT)).rejects.toBeInstanceOf(kind);
  });

  it.each([
    ["length", CutShort],
    ["content_filter", TranscriptionBlocked],
    ["error", StoppedPartWay],
  ])("keeps an empty response stopped for %s on the error path", async (reason, kind) => {
    answers("", reason);
    await expect(runUnderstand(TRANSCRIBE, recorder(), DEADLINE_AT)).rejects.toBeInstanceOf(kind);
  });

  it.each(["content_policy_violation", "refusal"])(
    "reads a refusal the service typed %s as a block",
    async (errorType) => {
      vi.mocked(understandMediaAt).mockRejectedValue(
        new UnderstandRefused(403, "SAFETY", "deployment", errorType),
      );
      await expect(runUnderstand(TRANSCRIBE, recorder(), DEADLINE_AT)).rejects.toBeInstanceOf(
        TranscriptionBlocked,
      );
    },
  );

  it("lets any other refusal through as it is", async () => {
    vi.mocked(understandMediaAt).mockRejectedValue(new UnderstandRefused(403, "budget", "deployment"));
    await expect(runUnderstand(TRANSCRIBE, recorder(), DEADLINE_AT)).rejects.toBeInstanceOf(
      UnderstandRefused,
    );
  });

  it("leaves an understanding that stopped part way as it was", async () => {
    answers("A dog on a", "content_filter");
    const [result] = await runUnderstand(
      { source_type: "image", source_url: "https://assets.invalid/image/a.png" },
      recorder(),
      DEADLINE_AT,
    );
    expect(result).toMatchObject({ outputs: [{ content: "A dog on a" }] });
    vi.mocked(understandMediaAt).mockRejectedValue(
      new UnderstandRefused(403, "SAFETY", "deployment", "content_policy_violation"),
    );
    await expect(
      runUnderstand({ source_type: "image", source_url: "https://assets.invalid/image/a.png" }, recorder(), DEADLINE_AT),
    ).rejects.toBeInstanceOf(UnderstandRefused);
  });
});
