// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cloneKeyOf, mentionsWritten, stepCalls, stepSource } from "../estimate.js";

const params = { elements: ["https://a/1.png", "https://a/2.png"], song: "https://a/song.mp3", empty: "", none: [] };

describe("the calls an extra step makes and the source each reads", () => {
  it("makes one call per item of a per-item step, one for a step over a single source, none for a param that carries nothing", () => {
    expect(stepCalls({ for_param: "elements", per_item: true }, params)).toEqual([0, 1]);
    expect(stepCalls({ for_param: "song" }, params)).toEqual([null]);
    expect(stepCalls({ for_param: "empty" }, params)).toEqual([]);
    expect(stepCalls({ for_param: "none", per_item: true }, params)).toEqual([]);
    expect(stepCalls({}, params)).toEqual([null]);
    expect(stepCalls({ for_param: "elements" }, params)).toEqual([null]);
    expect(stepCalls({ for_param: "song", per_item: true }, params)).toEqual([null]);
  });

  it("reads each call's own item, the whole value for a single call, and nothing that is not a url", () => {
    expect(stepSource(params, "elements", 0)).toBe("https://a/1.png");
    expect(stepSource(params, "elements", 1)).toBe("https://a/2.png");
    expect(stepSource(params, "song", null)).toBe("https://a/song.mp3");
    expect(stepSource(params, "elements", null)).toBeUndefined();
    expect(stepSource(params, "empty", null)).toBeUndefined();
    expect(stepSource(params, "elements", 2)).toBeUndefined();
    expect(stepSource(params, undefined, null)).toBeUndefined();
  });
});

describe("the source a clone is keyed by", () => {
  it("is the url the same call reads, for every kind, value shape and item index", () => {
    const urls = ["https://a/1.png", "https://a/2.png", "https://a/3.png"];
    const sourceKeys = Object.fromEntries(urls.map((u, i) => [u, `sha${i}`]));
    const value = fc.oneof(fc.constantFrom(...urls), fc.array(fc.constantFrom(...urls), { maxLength: 3 }), fc.constant(""), fc.constant(undefined));
    fc.assert(
      fc.property(fc.constantFrom("voice", "vocal", "element"), value, fc.option(fc.nat(3), { nil: null }), (kind, v, itemIndex) => {
        const params = { src: v };
        const url = stepSource(params, "src", itemIndex);
        const key = cloneKeyOf(kind, "src", params, sourceKeys, itemIndex);
        expect(key?.sourceKey.split(":")[0]).toBe(url === undefined ? undefined : sourceKeys[url]);
      }),
    );
  });
});

describe("the references a prompt names", () => {
  it("are written the upstream's way, counting from 1 or from 0, past the ninth", () => {
    expect(mentionsWritten({ images: "<IMG_{i}>", videos: "@video{n}" }, "<<ref:images:10>> and <<ref:videos:12>>")).toBe("<IMG_9> and @video12");
  });

  it("stay as they are where the upstream has no template for the param, or none at all", () => {
    expect(mentionsWritten({ images: "<IMG_{i}>" }, "<<ref:audios:1>>")).toBe("<<ref:audios:1>>");
    expect(mentionsWritten(undefined, "<<ref:audios:1>>")).toBe("<<ref:audios:1>>");
  });
});
