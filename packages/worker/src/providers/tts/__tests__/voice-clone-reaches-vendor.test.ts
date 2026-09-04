// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 PR2 — the picked reference recording survives the whole way to the
 * wire.
 *
 * The panel builds `params.audio` from the slot and the server's source gate
 * lets it through, but between that gate and the HTTP submit the worker keeps
 * only the params the MODEL DECLARES: `validateParams` drops the rest with an
 * `unknown_param_dropped` warning. A voice-cloning model whose yaml declares
 * no `audio` therefore submits `{text}` alone and clones nothing, with every
 * layer above reporting success.
 *
 * That is exactly what the model shipped with when it entered the catalog
 * (`d35e8c56f`, `params: {}`), and nothing turned red: the catalog tests read
 * the catalog, the panel tests read the panel, and the transport tests hand
 * the transport its params directly — none of them crosses the step that does
 * the dropping. So this walks the real chain, from the real config through
 * validation into the request the family builds.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "@breatic/core";

import { validateParams } from "@worker/providers/shared.js";
import { buildRequest } from "@worker/providers/tts/models/qwen.js";

const CLONE_MODEL = "qwen3-tts-voice-clone";
const REFERENCE = "https://cdn.example/reference.m4a";

// Stand in for the worker entry (composition root), the way the sibling
// provider tests do: the real catalog is read, only the environment is
// injected.
beforeAll(() => {
  initCore({
    DATABASE_URL: "postgres://localhost:5432/breatic_test",
    WAVESPEED_API_KEY: "test-wavespeed-key",
    TOPAZ_API_KEY: "test-topaz-key",
  });
});

describe("the reference recording reaches the vendor (#1960 PR2, C5)", () => {
  it("survives validation, which keeps only what the model declares", () => {
    const [name, cleaned] = validateParams("tts", CLONE_MODEL, {
      audio: REFERENCE,
    });
    expect(name).toBe(CLONE_MODEL);
    expect(cleaned.audio).toBe(REFERENCE);
  });

  it("is in the params the family hands the transport", async () => {
    const [, cleaned] = validateParams("tts", CLONE_MODEL, { audio: REFERENCE });
    const [prompt, apiParams] = await buildRequest("Say this.", CLONE_MODEL, cleaned);
    // `text` is filled by the tts entry point from the returned prompt; what
    // this pins is that the reference travelled beside it under the vendor's
    // own name.
    expect(prompt).toBe("Say this.");
    expect(apiParams.audio).toBe(REFERENCE);
  });

  it("comes through as the declared null when nothing was picked", () => {
    // `validateParams` fills a declared default whenever it is not undefined,
    // and `null` is not undefined — so an unpicked slot leaves `audio: null`
    // rather than no key at all. Pinned because it reads like the opposite:
    // a submit carrying that null is what the three entry points each refuse
    // first — the panel gate (`ref-audio-missing`), the server's source gate
    // (which tests `typeof value === "string"`), and the mini-tool schema
    // (`audio: z.string()`).
    const [, cleaned] = validateParams("tts", CLONE_MODEL, {});
    expect(cleaned.audio).toBeNull();
  });
});
