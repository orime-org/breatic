// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent's save (inner#1315): a picture found somewhere else is brought
 * into our storage, so a proposal can carry it. The storing is the server's;
 * this tool runs one at a time and says to the model what each refusal means.
 */

import { describe, it, expect, vi } from "vitest";
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import { SAVE_IMAGE, TOOL_MAP, CANVAS_TOOLS } from "@domain/agent/tools/index.js";
import { SaveRefused, type SavedMaterial, type SaveToStorage } from "@domain/agent/tools/save-image.js";

const LINK = "https://imgs.example/cat.jpg";
const SAVED: SavedMaterial = {
  url: "https://resource.example/url/2026-10-08/1_cat.jpg",
  mimeType: "image/jpeg",
  width: 1024,
  height: 768,
};

/** What one turn's copy of the tool is called with. */
type Call = (url: string, signal?: AbortSignal) => Promise<unknown>;

/**
 * A fresh copy of the tool, as one turn gets it, saving through `save`.
 * @param save - The storing the server hands over.
 * @returns A function that calls the tool's `execute`.
 * @throws {Error} When the tool is not registered.
 */
function turnCopy(save: SaveToStorage): Call {
  const build = TOOL_MAP[SAVE_IMAGE];
  if (!build) throw new Error("save_image is not registered");
  const execute = build().execute;
  if (!execute) throw new Error("save_image has no execute");
  return (url, signal) =>
    execute(
      { url },
      { toolCallId: "t1", messages: [], context: { saveToStorage: save }, ...(signal && { abortSignal: signal }) } as never,
    );
}

/**
 * What a failed call carries for the model and the reader.
 * @param call - The pending call.
 * @returns The failure attached to its error.
 * @throws {Error} When the call did not fail.
 */
async function failureOf(call: Promise<unknown>): Promise<ReturnType<typeof toolFailureOf>> {
  const err = await call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: unknown) => e,
  );
  return toolFailureOf(err);
}

describe("save_image", () => {
  it("is offered with the canvas tools", () => {
    expect(CANVAS_TOOLS).toContain(SAVE_IMAGE);
  });

  it("answers with our address for the saved picture", async () => {
    const save = vi.fn<SaveToStorage>().mockResolvedValue(SAVED);

    const answer = await turnCopy(save)(LINK);

    expect(save).toHaveBeenCalledWith(LINK, undefined);
    expect(answer).toEqual(SAVED);
  });

  it("hands the turn's stop signal to the storing", async () => {
    const save = vi.fn<SaveToStorage>().mockResolvedValue(SAVED);
    const stop = new AbortController();

    await turnCopy(save)(LINK, stop.signal);

    expect(save).toHaveBeenCalledWith(LINK, stop.signal);
  });

  it("turns a second call away while the first is still saving", async () => {
    let finish: (value: SavedMaterial) => void = () => undefined;
    const save = vi.fn<SaveToStorage>().mockImplementationOnce(
      () => new Promise<SavedMaterial>((resolve) => (finish = resolve)),
    );
    const call = turnCopy(save);

    const first = call(LINK);
    const second = await failureOf(call("https://imgs.example/dog.jpg"));
    finish(SAVED);
    await first;

    expect(second?.kind).toBe("turned_away");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves again once the first save has answered", async () => {
    const save = vi.fn<SaveToStorage>().mockResolvedValue(SAVED);
    const call = turnCopy(save);

    await call(LINK);
    await call("https://imgs.example/dog.jpg");

    expect(save).toHaveBeenCalledTimes(2);
  });

  it("frees the next save when one fails", async () => {
    const save = vi
      .fn<SaveToStorage>()
      .mockRejectedValueOnce(new SaveRefused("link", "source_unreachable"))
      .mockResolvedValueOnce(SAVED);
    const call = turnCopy(save);

    await call(LINK).catch(() => undefined);

    await expect(call(LINK)).resolves.toEqual(SAVED);
  });

  it("reports a stop as the turn being stopped", async () => {
    const stop = new AbortController();
    const save = vi.fn<SaveToStorage>().mockImplementation(() => {
      stop.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });

    const failure = await failureOf(turnCopy(save)(LINK, stop.signal));

    expect(failure?.kind).toBe("user_aborted");
  });

  it("refuses a saved file that is not a picture", async () => {
    const save = vi.fn<SaveToStorage>().mockResolvedValue({ ...SAVED, mimeType: "video/mp4" });

    const failure = await failureOf(turnCopy(save)(LINK));

    expect(failure?.kind).toBe("tool_failed");
    expect(failure?.forModel).toContain("video/mp4");
  });

  it.each([
    ["link", "source_unreachable", FAILURE_LINES.linkUnreachable],
    ["link", "unsupported_type", FAILURE_LINES.unsupportedType],
    ["link", "over_cap", FAILURE_LINES.fileTooLarge],
    ["link", "empty", FAILURE_LINES.emptyFile],
    ["rate_limited", undefined, FAILURE_LINES.tooFrequent],
    ["storage_full", undefined, FAILURE_LINES.storageFull],
    ["no_access", undefined, FAILURE_LINES.noPermission],
  ] as const)("says what a %s refusal (%s) means", async (kind, detail, line) => {
    const save = vi.fn<SaveToStorage>().mockRejectedValue(new SaveRefused(kind, detail));

    const failure = await failureOf(turnCopy(save)(LINK));

    expect(failure?.kind).toBe("tool_failed");
    expect(failure && "readerKey" in failure ? failure.readerKey : undefined).toBe(line);
  });

  it("names the link's own reason to the model", async () => {
    const save = vi.fn<SaveToStorage>().mockRejectedValue(new SaveRefused("link", "over_cap"));

    const failure = await failureOf(turnCopy(save)(LINK));

    expect(failure?.forModel).toContain("over_cap");
  });

  it("reports a failure of our own as one", async () => {
    const down = new Error("db down");
    const save = vi.fn<SaveToStorage>().mockRejectedValue(down);

    const thrown = await turnCopy(save)(LINK).then(
      () => {
        throw new Error("expected the call to fail");
      },
      (e: unknown) => e,
    );
    const failure = toolFailureOf(thrown);

    expect(failure?.kind).toBe("tool_failed");
    expect(failure && "readerKey" in failure ? failure.readerKey : undefined).toBe(FAILURE_LINES.ourFault);
    expect((thrown as Error).cause, "the turn's log keeps what broke").toBe(down);
  });
});
