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

describe("running one understand task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    missing = [];
    vi.mocked(understandMediaAt).mockResolvedValue({
      text: "A red bicycle against a brick wall.",
      finishReason: "stop",
      kind: "image",
    });
  });

  // The type the ledger read off the landed bytes travels with the request,
  // because the browser's own format gate judged by it: storage answers for
  // the same address with the type a ticket signed, guessed from a file name.
  // This is the middle of that chain — the end that judges is a package away.
  it("hands over the type the ledger judged, when the press knew it", async () => {
    await runUnderstand({ ...PARAMS, source_mime_type: "image/png" }, recorder(), false);

    expect(vi.mocked(understandMediaAt)).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerType: "image/png" }),
    );
  });

  // A node stored before the ledger reported its type carries none, and the
  // run judges by the address the way it did before.
  it("hands over no type when the press had none", async () => {
    await runUnderstand(PARAMS, recorder(), false);

    const [args] = vi.mocked(understandMediaAt).mock.calls[0] ?? [];
    expect(args).not.toHaveProperty("ledgerType");
  });

  it("hands the address and the ceilings to the shared capability", async () => {
    await runUnderstand(PARAMS, recorder(), false);

    expect(vi.mocked(understandMediaAt)).toHaveBeenCalledWith(
      expect.objectContaining({
        url: PARAMS.source_url,
        maxBytes: expect.any(Number),
        fetchTimeoutMs: expect.any(Number),
        minBytesPerSec: expect.any(Number),
        readFloorMs: expect.any(Number),
        timeoutMs: expect.any(Number),
        maxOutputTokens: expect.any(Number),
        question: expect.any(String),
        model: expect.any(String),
        apiKey: "test-key",
        baseUrl: expect.any(String),
      }),
    );
  });

  it("carries the text back as the content one node gets", async () => {
    const [result] = await runUnderstand(PARAMS, recorder(), false);

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
    });

    await expect(runUnderstand(PARAMS, recorder(), false)).rejects.toThrow();
  });

  // The media was the prompt, so a call that wrote nothing was still paid
  // for. The run fails and charges nothing, and the row says what it cost.
  it("records what an empty answer cost before failing", async () => {
    billedThen(0.0041, () => ({ text: "", finishReason: "content_filter", kind: "image" }));

    await expect(runUnderstand(PARAMS, recorder(), false)).rejects.toThrow();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "model", costUsd: 0.0041, costSource: "provider" });
  });

  // The run is gated on credits before it goes out, so it has to be charged
  // after. What it charges is what the service said it took, converted the
  // one way every other transport's cost is: dollars to cents, times the
  // deployment's multiplier.
  it("charges what the service said the call cost", async () => {
    billedThen(0.0037, () => ({ text: "A red bicycle.", finishReason: "stop", kind: "image" }));

    const [, credits] = await runUnderstand(PARAMS, recorder(), false);

    expect(credits).toBeCloseTo(0.0037 * 100 * MULTIPLIER, 10);
  });

  // A service that answered without saying what it cost has not said zero.
  // Charging zero would be this path inventing a figure; the run is recorded
  // uncharged and reconciliation is where an unpriced run belongs.
  it("charges nothing when the service did not say what it cost", async () => {
    billedThen(undefined, () => ({ text: "A red bicycle.", finishReason: "stop", kind: "image" }));
    const [, credits] = await runUnderstand(PARAMS, recorder(), false);

    expect(credits).toBe(0);
    // Recorded at zero and reported, so reconciliation can find it.
    expect(missing).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costSource: "missing" });
  });

  it("records the call it charged for", async () => {
    billedThen(0.0037, () => ({ text: "A red bicycle.", finishReason: "stop", kind: "image" }));

    await runUnderstand(PARAMS, recorder(), false);

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

    await expect(runUnderstand(PARAMS, recorder(), false)).rejects.toBeInstanceOf(UnderstandRefused);

    expect(rows).toEqual([expect.objectContaining({ costUsd: 0.002, costSource: "provider" })]);
  });

  it("records nothing when the media never reached the service", async () => {
    vi.mocked(understandMediaAt).mockRejectedValue(new MediaUnavailable("too-large", {}));

    await expect(runUnderstand(PARAMS, recorder(), false)).rejects.toBeInstanceOf(MediaUnavailable);

    expect(rows).toEqual([]);
  });

  // The words this produces are the node's body, and a reader opens that
  // node in the language they set. Nothing about the media says which that
  // is, so the run is told — and the telling has to reach the model, because
  // the model is what decides the language of the answer.
  it("asks in the language the reader set", async () => {
    await runUnderstand({ ...PARAMS, reader_locale: "zh-CN" }, recorder(), false);

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
    await runUnderstand(PARAMS, recorder(), false);
    await runUnderstand({ ...PARAMS, reader_locale: "xx-YY" }, recorder(), false);

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
      false,
    );

    const asked = vi.mocked(understandMediaAt).mock.calls[0]?.[0].question;
    expect(asked).toContain("How many people are in this?");
    expect(asked).toContain("Japanese");
  });

  it("lets the capability's own failures through as they are", async () => {
    vi.mocked(understandMediaAt).mockRejectedValue(new MediaUnavailable("too-large", {}));

    await expect(runUnderstand(PARAMS, recorder(), false)).rejects.toBeInstanceOf(
      MediaUnavailable,
    );
  });
});
