// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { generationIdOf, trackOpenGeneration } from "@domain/credit/open-generation.js";

describe("reading the generation id off a raw chunk", () => {
  it("takes the id OpenRouter puts on every streamed chunk", () => {
    expect(generationIdOf({ id: "gen-123", choices: [] })).toBe("gen-123");
  });

  it("ignores anything that is not an OpenRouter chunk", () => {
    expect(generationIdOf(undefined)).toBeUndefined();
    expect(generationIdOf("gen-1")).toBeUndefined();
    expect(generationIdOf({ id: 7 })).toBeUndefined();
    expect(generationIdOf({ id: "chatcmpl-1" })).toBeUndefined();
  });
});

describe("tracking the model call that has not ended", () => {
  it("holds the id of a call that started and did not end", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.seen({ id: "gen-1" });
    expect(open.pending()).toBe("gen-1");
  });

  // When a stream's first chunk is an in-band error, the provider never sends
  // the id on to the SDK, and the end event carries the SDK's own id instead.
  it("closes the call it holds when the end carries another id", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.ended("aitxt-1");
    open.seen({ id: "gen-1" });
    expect(open.pending()).toBeUndefined();
  });

  it("lets go of a call once it ended", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.ended("gen-1");
    expect(open.pending()).toBeUndefined();
  });

  // A slow reader of the stream receives the call's last raw chunk after the
  // call ended; that chunk must not open the call again.
  it("does not reopen a call whose last chunk arrives after it ended", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.ended("gen-1");
    open.seen({ id: "gen-1" });
    expect(open.pending()).toBeUndefined();
  });

  it("holds the later call when an earlier one ended first", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.ended("gen-1");
    open.seen({ id: "gen-2" });
    expect(open.pending()).toBe("gen-2");
  });
});
