// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldFits, missingRequired, snapshotOf, type SchemaSnapshot } from "@provider/config/upstream-schema.js";

/** fal's published OpenAPI documents, as fetched from `fal.ai/api/openapi/queue/openapi.json?endpoint_id=...`. */
const openapi = (name: string): { components: { schemas: Record<string, unknown> } } =>
  JSON.parse(readFileSync(resolve(__dirname, "samples", `${name}.json`), "utf8")) as { components: { schemas: Record<string, unknown> } };

/**
 * The snapshot of one input schema of a fal document.
 * @param name - The sample.
 * @param input - The input schema's name.
 * @returns The snapshot.
 */
function falInput(name: string, input: string): SchemaSnapshot {
  const doc = openapi(name);
  return snapshotOf(doc.components.schemas[input], { root: doc, source: `sample:${name}` });
}

describe("snapshotOf", () => {
  it("lists fields and required fields by name, whatever order the upstream's document holds them in", () => {
    const forward = snapshotOf({ type: "object", required: ["b", "a"], properties: { b: { type: "string" }, a: { type: "integer" } } }, { root: {}, source: "s" });
    const reversed = snapshotOf({ type: "object", required: ["a", "b"], properties: { a: { type: "integer" }, b: { type: "string" } } }, { root: {}, source: "s" });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(Object.keys(forward.fields)).toEqual(["a", "b"]);
    expect(forward.required).toEqual(["a", "b"]);
  });

  it("keeps every branch of a union and expands an object branch into dotted fields", () => {
    const snap = falInput("fal-ai_flux_dev", "FluxDevInput");
    expect(snap.source).toBe("sample:fal-ai_flux_dev");
    expect(snap.required).toEqual(["prompt"]);
    const imageSize = snap.fields["image_size"];
    expect(imageSize?.map((leaf) => leaf.type).sort()).toEqual(["object", "string"]);
    expect(imageSize?.find((leaf) => leaf.type === "string")?.enum).toContain("landscape_16_9");
    expect(snap.fields["image_size.width"]).toEqual([expect.objectContaining({ type: "integer", maximum: 14142, exclusiveMinimum: 0 })]);
    expect(snap.fields["guidance_scale"]).toEqual([expect.objectContaining({ type: "number", minimum: 1, maximum: 20 })]);
  });

  it("records a null branch as one more accepted shape", () => {
    const snap = falInput("fal-ai_flux_dev", "FluxDevInput");
    expect(snap.fields["seed"]?.map((leaf) => leaf.type).sort()).toEqual(["integer", "null"]);
  });

  it("resolves references and expands nested objects of a reference", () => {
    const snap = falInput("fal-ai_minimax_speech-2.8-hd", "MinimaxSpeech28HdInput");
    expect(snap.fields["voice_setting"]?.map((leaf) => leaf.type)).toEqual(["object"]);
    expect(snap.fields["voice_setting.voice_id"]).toEqual([expect.objectContaining({ type: "string" })]);
    expect(snap.fields["voice_setting.pitch"]).toEqual([expect.objectContaining({ type: "integer", minimum: -12, maximum: 12 })]);
    expect(snap.fields["pronunciation_dict"]?.map((leaf) => leaf.type).sort()).toEqual(["null", "object"]);
    const toneList = snap.fields["pronunciation_dict.tone_list"];
    expect(toneList).toEqual([expect.objectContaining({ type: "array" })]);
    expect(toneList?.[0]?.items?.fields[""]).toEqual([expect.objectContaining({ type: "string" })]);
  });

  it("records each item of an array union with its own fields and required ones", () => {
    const snap = falInput("fal-ai_gemini-tts", "GeminiTtsInput");
    const speakers = snap.fields["speakers"];
    expect(speakers?.map((leaf) => leaf.type).sort()).toEqual(["array", "null"]);
    const list = speakers?.find((leaf) => leaf.type === "array");
    expect(list).toEqual(expect.objectContaining({ minItems: 2, maxItems: 10 }));
    expect(list?.items?.required.sort()).toEqual(["speaker_id", "voice"]);
    expect(list?.items?.fields["voice"]?.[0]?.enum).toContain("Charon");
  });

  it("reads output schemas the same way", () => {
    const doc = openapi("fal-ai_flux_dev");
    const out = snapshotOf(doc.components.schemas["FluxDevOutput"], { root: doc, source: "sample" });
    expect(out.fields["images"]).toEqual([expect.objectContaining({ type: "array" })]);
    expect(out.fields["images"]?.[0]?.items?.fields["url"]).toEqual([expect.objectContaining({ type: "string" })]);
  });

  it("survives a JSON round trip unchanged", () => {
    const snap = falInput("fal-ai_gemini-tts", "GeminiTtsInput");
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("records the value the upstream uses for a field a request leaves out", () => {
    const snap = falInput("fal-ai_flux_dev", "FluxDevInput");
    expect(snap.fields["guidance_scale"]).toEqual([expect.objectContaining({ default: 3.5 })]);
    expect(snap.fields["enable_safety_checker"]).toEqual([expect.objectContaining({ type: "boolean", default: true })]);
    expect(snap.fields["image_size"]?.every((leaf) => leaf.default === "landscape_4_3")).toBe(true);
    expect(snap.fields["seed"]?.some((leaf) => "default" in leaf)).toBe(false);
  });

  it("records a string's length bounds and pattern, in a list item too", () => {
    const snap = falInput("fal-ai_gemini-tts", "GeminiTtsInput");
    expect(snap.fields["prompt"]).toEqual([expect.objectContaining({ type: "string", minLength: 1, maxLength: 50000 })]);
    const list = snap.fields["speakers"]?.find((leaf) => leaf.type === "array");
    expect(list?.items?.fields["speaker_id"]).toEqual([expect.objectContaining({ type: "string", pattern: "^\\w+$" })]);
  });
});

describe("snapshotOf on an object whose anyOf names alternative required fields", () => {
  const either = snapshotOf(
    {
      type: "object",
      properties: { prompt: { type: "string" }, draft_id: { type: "string" }, duration: { type: "integer", minimum: 4, maximum: 30 } },
      anyOf: [{ required: ["prompt"] }, { required: ["draft_id"] }],
    },
    { root: {}, source: "inline" },
  );

  it("keeps the object's own fields", () => {
    expect(Object.keys(either.fields).sort()).toEqual(["draft_id", "duration", "prompt"]);
    expect(fieldFits(either, "duration", 5)).toBe(true);
  });

  it("asks for one alternative, not all of them", () => {
    expect(missingRequired(either, { prompt: "a fox" })).toEqual([]);
    expect(missingRequired(either, { draft_id: "d1" })).toEqual([]);
    expect(missingRequired(either, { duration: 5 })).not.toEqual([]);
  });

  it("survives a JSON round trip unchanged", () => {
    expect(JSON.parse(JSON.stringify(either))).toEqual(either);
  });
});

describe("fieldFits", () => {
  const flux = (): SchemaSnapshot => falInput("fal-ai_flux_dev", "FluxDevInput");
  const speech = (): SchemaSnapshot => falInput("fal-ai_minimax_speech-2.8-hd", "MinimaxSpeech28HdInput");
  const tts = (): SchemaSnapshot => falInput("fal-ai_gemini-tts", "GeminiTtsInput");

  it("takes a value any branch accepts", () => {
    expect(fieldFits(flux(), "image_size", "square_hd")).toBe(true);
    expect(fieldFits(flux(), "image_size", { width: 1024, height: 768 })).toBe(true);
    expect(fieldFits(flux(), "seed", 42)).toBe(true);
    expect(fieldFits(flux(), "seed", null)).toBe(true);
  });

  it("refuses a value outside the enum, the type or the bounds", () => {
    expect(fieldFits(flux(), "image_size", "16:9")).toBe(false);
    expect(fieldFits(flux(), "image_size", { width: 0, height: 768 })).toBe(false);
    expect(fieldFits(flux(), "guidance_scale", 21)).toBe(false);
    expect(fieldFits(flux(), "guidance_scale", "3.5")).toBe(false);
    expect(fieldFits(flux(), "seed", 1.5)).toBe(false);
  });

  it("refuses a field the schema does not have", () => {
    expect(fieldFits(flux(), "aspect_ratio", "16:9")).toBe(false);
    expect(fieldFits(speech(), "voice_setting.timbre", 1)).toBe(false);
  });

  it("checks a dotted field and the items of a list", () => {
    expect(fieldFits(speech(), "voice_setting.pitch", -12)).toBe(true);
    expect(fieldFits(speech(), "voice_setting.pitch", 13)).toBe(false);
    expect(fieldFits(speech(), "pronunciation_dict.tone_list", ["a/b"])).toBe(true);
    expect(fieldFits(speech(), "pronunciation_dict.tone_list", [1])).toBe(false);
  });

  it("refuses a string outside its length bounds or pattern", () => {
    expect(fieldFits(tts(), "prompt", "Hello")).toBe(true);
    expect(fieldFits(tts(), "prompt", "")).toBe(false);
    expect(fieldFits(tts(), "prompt", "x".repeat(50001))).toBe(false);
    const speakers = (first: string): unknown[] => [{ speaker_id: first, voice: "Charon" }, { speaker_id: "Guest", voice: "Kore" }];
    expect(fieldFits(tts(), "speakers", speakers("Host_1"))).toBe(true);
    expect(fieldFits(tts(), "speakers", speakers("Al ice"))).toBe(false);
  });

  it("reads \\w in a pattern as Unicode word characters, as the upstream's validator does", () => {
    const speakers = (first: string): unknown[] => [{ speaker_id: first, voice: "Charon" }, { speaker_id: "Guest", voice: "Kore" }];
    for (const name of ["主持人", "José", "Jose\u0301", "김민수", "٣"]) expect(fieldFits(tts(), "speakers", speakers(name)), name).toBe(true);
    for (const name of ["李·明", "张，三", "a\u00a0b", "😀"]) expect(fieldFits(tts(), "speakers", speakers(name)), name).toBe(false);
  });

  it("checks each item's fields and the list's length", () => {
    const two = [{ speaker_id: "Host", voice: "Charon" }, { speaker_id: "Guest", voice: "Kore" }];
    expect(fieldFits(tts(), "speakers", two)).toBe(true);
    expect(fieldFits(tts(), "speakers", [two[0]])).toBe(false);
    expect(fieldFits(tts(), "speakers", [two[0], { speaker_id: "Guest", voice: "Nobody" }])).toBe(false);
  });
});

describe("missingRequired", () => {
  it("names the required fields a body lacks, at the top and in each item", () => {
    const doc = openapi("fal-ai_gemini-tts");
    const snap = snapshotOf(doc.components.schemas["GeminiTtsInput"], { root: doc, source: "sample" });
    expect(missingRequired(snap, { prompt: "Hello" })).toEqual([]);
    expect(missingRequired(snap, {})).toEqual(["prompt"]);
    expect(missingRequired(snap, { prompt: "Hi", speakers: [{ speaker_id: "A", voice: "Kore" }, { voice: "Puck" }] })).toEqual(["speakers[1].speaker_id"]);
  });

  it("asks for a nested object's required fields only when the object is sent", () => {
    const nested: SchemaSnapshot = snapshotOf(
      { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "object", required: ["c"], properties: { c: { type: "integer" } } } } },
      { root: {}, source: "inline" },
    );
    expect(missingRequired(nested, { a: "x" })).toEqual([]);
    expect(missingRequired(nested, { a: "x", b: {} })).toEqual(["b.c"]);
  });
});
