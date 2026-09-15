// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the catalog's own prose is allowed to claim (#261).
 *
 * Two answers quote a sentence of it whole -- a mode's description and a
 * model's guide -- while everything around them is built from the panel
 * tables and filtered against what this deployment can reach. A reader picks
 * a mode and then a model off those two sentences, so a source they name that
 * the mode has not, or a capability they sell that nothing here can set, is a
 * choice made on a promise nothing keeps.
 *
 * Only falsifiable claims are checked. "Highest aesthetic quality" is not one,
 * and a rule that flagged it would flag four fifths of the catalog; each rule
 * below is decided by the catalog or the panel tables alone.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { MODE_SOURCE_FIELDS, PANEL_PARAM_CONTROLS } from "@breatic/shared";
import type { ModelEntry } from "@breatic/shared";

import { getModelCatalog } from "../model-catalog.js";
import { entriesForNode, getCanvasCapabilities, modelsForMode } from "../mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

/** Phrases a guide uses for a slot, and the parameters that slot arrives in. */
const PROMISED_SLOT: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/reference images?/i, ["images", "style_images"]],
  [/end frames?/i, ["end_image"]],
];

/**
 * Phrases a mode's description names a source by, and the parameters it
 * arrives in. Wider than a model's list: a mode describes the gesture rather
 * than the field, so "the image becomes the first frame" and "a portrait
 * image and audio" are both a claim about which slots the picker will offer.
 */
const MODE_PROMISED_SOURCE: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/reference images?/i, ["images", "style_images"]],
  [/reference video|driving motion/i, ["video"]],
  [/reference audio|audio (sample|track)/i, ["audio", "song"]],
  [/first frame|portrait image|character image/i, ["image"]],
  [/ends on another|end frame/i, ["end_image"]],
];

/** How a mode says it needs no source at all, which its slot list decides. */
const MODE_CLAIMS_NOTHING_NEEDED = /no (media input|reference audio) (needed|required)/i;

/**
 * Words after which the rest of their clause is being denied.
 *
 * A description says what a mode is not as readily as what it is -- "rather
 * than being the first frame", "no reference audio needed" -- and the phrases
 * above match either way round. Read without this, both of those say the mode
 * takes a source they were written to say it does not.
 */
const DENIAL = /\b(no|not|never|without|rather than|instead of)\b/i;

/**
 * The clauses of a description that are asserting something.
 *
 * Punctuation and "but" divide the clauses, so a denial in one does not silence
 * its neighbour, and any clause carrying a denial is left out entirely.
 *
 * How far a denial reaches inside its own clause is not decidable from the word
 * order: it governs what follows in "rather than being the first frame" and
 * what precedes in "reference images are not used here". Reading only part of
 * such a clause would call a denied source a claim, so the whole clause goes
 * unread -- these rules miss claims rather than invent them.
 * @param text - The description as the answer quotes it.
 * @returns The clauses that assert, in order.
 */
function affirmedClauses(text: string): string[] {
  return text
    .split(/[.,;:—]|\bbut\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !DENIAL.test(clause));
}

/** Phrases a guide sells a capability by, and the parameter that would do it. */
const PROMISED_CAPABILITY: ReadonlyArray<readonly [RegExp, string]> = [
  [/loop(ing)?\b/i, "loop"],
  [/camera lock/i, "camera_fixed"],
  [/negative prompts?/i, "negative_prompt"],
  [/web search/i, "enable_web_search"],
];

/** A span of seconds a guide states, which the model's own duration decides. */
const STATED_SECONDS = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:s\b|sec\b|seconds\b)/i;

/** Claims about being the slowest or the dearest, which the node decides. */
const CLAIMS_EXTREME: ReadonlyArray<readonly [RegExp, "cost" | "time"]> = [
  [/most expensive/i, "cost"],
  [/cheapest/i, "cost"],
  [/slowest/i, "time"],
  [/fastest/i, "time"],
];

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("a model's guide", () => {
  it("claims nothing this deployment cannot give", () => {
    useFullCatalog();
    // Zero keys reads every model out, so the walk below would pass over an
    // empty catalog and say nothing.
    expect(Object.keys(getModelCatalog()).length, "the catalog loaded").toBeGreaterThan(0);
    const broken = new Set<string>();
    let read = 0;
    // Per mode, not per node: a guide is read where the answer prints it, and
    // both the set a superlative is measured against and the sources a reader
    // can point at belong to the one mode they asked about. A node's buckets
    // also hold entries no generation mode offers -- the upscalers and the
    // background remover sit in the image bucket -- and measuring "cheapest"
    // against those measures it against models the reader never sees.
    for (const { nodeType, modes } of getCanvasCapabilities()) {
      const byName = new Map(entriesForNode(nodeType).map((e) => [e.name, e]));
      for (const { mode } of modes) {
        const answer = modelsForMode(nodeType, mode);
        if (!answer.available) continue;
        const shown = answer.models
          .map((m) => byName.get(m.name))
          .filter((e): e is ModelEntry => e !== undefined);
        if (shown.length === 0) continue;
        const dearest = Math.max(...shown.map((e) => e.cost_per_call));
        const cheapest = Math.min(...shown.map((e) => e.cost_per_call));
        const slowest = Math.max(...shown.map((e) => e.generation_time));
        const quickest = Math.min(...shown.map((e) => e.generation_time));
        const pickable = new Set(MODE_SOURCE_FIELDS[nodeType][mode] ?? []);
        for (const entry of shown) {
          // The same fallback the projection takes: an entry with no guide has
          // its description quoted on the head line instead, and a rule that
          // read only the guide would pass over whatever that sentence claims.
          const guide = (entry.guide || entry.description || "").replace(/\s+/g, " ");
          if (guide.length === 0) continue;
          read += 1;
          // The same clause reading the mode descriptions get: this is prose in
          // the same register, written by the same hand, and it denies as
          // readily as it asserts.
          const clauses = affirmedClauses(guide);
          const says = (phrase: RegExp): boolean =>
            clauses.some((clause) => phrase.test(clause));
          const named = (what: string): void => {
            broken.add(`${nodeType}/${mode}/${entry.name}: ${what}`);
          };
          for (const [phrase, params] of PROMISED_SLOT) {
            if (!says(phrase)) continue;
            if (params.some((param) => entry.params[param] !== undefined)) continue;
            named(`promises ${params.join(" or ")}, which it does not declare`);
          }
          for (const [phrase, param] of PROMISED_CAPABILITY) {
            if (!says(phrase) || entry.params[param] === undefined) continue;
            if (PANEL_PARAM_CONTROLS[nodeType].includes(param) || pickable.has(param)) continue;
            named(`sells ${param}, for which this mode draws no control`);
          }
          const span = clauses.map((clause) => clause.match(STATED_SECONDS)).find(Boolean);
          // A span stated by a model with no length parameter is how long
          // generating takes, which the head line states as its own ceiling.
          const duration = entry.params.duration ?? entry.params.duration_seconds;
          if (span != null && duration !== undefined) {
            const [low, high] = [Number(span[1]), Number(span[2])];
            const stops = (duration?.values ?? []).filter(
              (value): value is number => typeof value === "number",
            );
            const ends =
              stops.length > 0
                ? [Math.min(...stops), Math.max(...stops)]
                : [duration?.min, duration?.max];
            if (ends[0] !== low || ends[1] !== high) {
              named(`states ${span[0]} while its duration runs ${ends[0]} to ${ends[1]}`);
            }
          }
          for (const [phrase, field] of CLAIMS_EXTREME) {
            if (!says(phrase)) continue;
            const mine = field === "cost" ? entry.cost_per_call : entry.generation_time;
            const [most, least] =
              field === "cost" ? [dearest, cheapest] : [slowest, quickest];
            const superlative = /most expensive|slowest/i.test(phrase.source) ? most : least;
            if (mine !== superlative) {
              named(`calls itself ${phrase.source} at ${mine} while this mode runs ${least} to ${most}`);
            }
          }
        }
      }
    }
    expect(read, "the catalog writes some guides").toBeGreaterThan(0);
    expect([...broken], "say what this deployment gives, or stop claiming it").toEqual([]);
  });
});

describe("a mode's description", () => {
  it("names only the sources its picker offers", () => {
    useFullCatalog();
    const capabilities = getCanvasCapabilities();
    expect(capabilities.length, "the catalog backs some modes").toBeGreaterThan(0);
    const broken: string[] = [];
    let read = 0;
    for (const { nodeType, modes } of capabilities) {
      for (const { mode, what } of modes) {
        const text = what.replace(/\s+/g, " ");
        if (text.length === 0) continue;
        read += 1;
        const slots = MODE_SOURCE_FIELDS[nodeType][mode] ?? [];
        const clauses = affirmedClauses(text);
        for (const [phrase, params] of MODE_PROMISED_SOURCE) {
          if (!clauses.some((clause) => phrase.test(clause))) continue;
          if (params.some((param) => slots.includes(param))) continue;
          broken.push(
            `${nodeType}/${mode}: names ${params.join(" or ")}, which this mode does not take`,
          );
        }
        if (MODE_CLAIMS_NOTHING_NEEDED.test(text) && slots.length > 0) {
          broken.push(`${nodeType}/${mode}: says nothing is needed while it takes ${slots.join(", ")}`);
        }
      }
    }
    expect(read, "the catalog describes some modes").toBeGreaterThan(0);
    expect(broken, "describe the sources this mode offers, or stop naming them").toEqual([]);
  });
});
