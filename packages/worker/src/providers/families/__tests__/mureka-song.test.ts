// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Mureka V9.5 Song's compose-from setting (breatic#1393) is ours alone: it
 * picks which slots and whether the style box a run uses, and no upstream
 * has a field for it.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { initCore } from "@breatic/core";
import { getFullModelConfig } from "@breatic/domain";

import { FAMILIES } from "@worker/providers/generate.js";
import { upstreamBody } from "@worker/providers/upstream-body.js";

/** The run's deadline, which nothing here reaches. */
const RUN = new AbortController().signal;

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test" });
});

describe("the Mureka V9.5 Song family", () => {
  const family = FAMILIES.get("mureka-v9.5-generate-song");

  it("keeps compose_from out of the request and leaves the prompt as it is", async () => {
    expect(family?.CONSUMES.has("compose_from")).toBe(true);
    expect(await family?.prepare("lo-fi", { compose_from: "references" }, RUN)).toEqual({ prompt: "lo-fi", fields: {} });
  });

  it("sends a melody run as the lyrics and the melody alone", () => {
    const entry = getFullModelConfig("audio").models.find((m) => m.name === "mureka-v9.5-generate-song");
    if (!entry) throw new Error("mureka-v9.5-generate-song missing from the audio catalog");
    expect(upstreamBody(entry, { compose_from: "melody", lyrics: "la", melody: "m-id" }, "", family?.CONSUMES)).toEqual({
      lyrics: "la",
      melody_id: "m-id",
    });
  });
});
