// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { bearerHeaders, inlineLimits, limits, outputField, outputUrls, type Reach } from "../adapter.js";
import { adapterOf } from "../adapters.js";
import { falAdapter } from "../fal/adapter.js";
import { sandbaseAdapter } from "../sandbase/adapter.js";
import { wavespeedAdapter } from "../wavespeed/adapter.js";

describe("the read limits of a media request", () => {
  it("lets an answer without a deadline stall a minute, up to 10 MiB", () => {
    expect(limits({})).toEqual({ maxBodyBytes: 10 * 1024 * 1024, idleMs: 60_000 });
  });

  it("lets an answer stall until the deadline, and at least a millisecond past it", () => {
    const { idleMs } = limits({ deadlineAt: Date.now() + 5_000 });
    expect(idleMs).toBeLessThanOrEqual(5_000);
    expect(idleMs).toBeGreaterThan(4_000);
    expect(limits({ deadlineAt: Date.now() - 10 }).idleMs).toBe(1);
  });

  it("reads an answer with an inline file up to the media limit as base64 and room for the JSON around it", () => {
    expect(inlineLimits({ maxMediaBytes: 3_000 }).maxBodyBytes).toBe(4_000 + 2_048);
    expect(inlineLimits({ maxMediaBytes: 3_001 }).maxBodyBytes).toBe(4_004 + 2_048);
    expect(inlineLimits({}).maxBodyBytes).toBe(10 * 1024 * 1024);
  });
});

describe("a step's output", () => {
  it("is its first output's field when that is a string", () => {
    expect(outputField([{ id: "v1" }, { id: "v2" }], "id")).toBe("v1");
  });

  it.each([["empty", [{ id: "" }]], ["a number", [{ id: 5 }]], ["absent", [{}]], ["null output", [null]], ["no output", []]])("is refused when the field is %s", (_label, outputs) => {
    expect(() => outputField(outputs, "id")).toThrow("No id in the upstream answer");
  });

  it("reads every output as a url", () => {
    expect(outputUrls(["https://a/1.png", "https://a/2.png"])).toEqual(["https://a/1.png", "https://a/2.png"]);
  });

  it.each([["none", []], ["an empty one", ["https://a/1.png", ""]], ["one that is not a string", ["https://a/1.png", 5]], ["only empty", [""]]])("refuses outputs with %s", (_label, outputs) => {
    expect(() => outputUrls(outputs)).toThrow("The upstream answered no output url");
  });
});

describe("a bearer upstream's headers", () => {
  it("carry the key and a JSON body type", () => {
    expect(bearerHeaders({ key: "k" } as Reach)).toEqual({ authorization: "Bearer k", "content-type": "application/json" });
  });
});

describe("the adapter of an upstream kind", () => {
  it("is the one that speaks to it", () => {
    expect([adapterOf("wavespeed"), adapterOf("fal"), adapterOf("sandbase")]).toEqual([wavespeedAdapter, falAdapter, sandbaseAdapter]);
  });

  it.each(["falai", "openrouter", "toString"])("is refused for %s, which no media adapter speaks to", (kind) => {
    expect(() => adapterOf(kind)).toThrow(`No media adapter speaks to upstreams of kind "${kind}"`);
  });
});
