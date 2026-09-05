// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every model that needs a source declares the param that carries it (#1960).
 *
 * The server's execute gate now asks two questions of a submitted payload —
 * is the field one this source type travels under, and does this model declare
 * it — because the audio vocabulary spans six spellings read by four different
 * modes, and one model satisfying its gate through another vendor's spelling
 * is a request the transport cannot build.
 *
 * That second question rests on this: a model requiring a source declares the
 * field. It always had to be true (the transport builds its request from the
 * declared params, so an undeclared field reaches the upstream as nothing),
 * but nothing checked it. A model failing here is refused at the gate, which
 * is a 400 on a request the user made correctly.
 */

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig, MODALITIES } from "@domain/model-catalog/model-catalog.js";
import { computeSourcesByMode } from "@domain/model-catalog/source-requirement.js";

beforeAll(() => {
  initCore(process.env);
});

/** The fields each source type may travel under, mirroring the gate's table. */
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  image: ["images", "image", "end_image"],
  video: ["video", "video_url"],
  audio: ["audio", "audio_url", "ref_audio_url", "song", "voice", "instrumental"],
};

describe("every model needing a source declares a field that carries it", () => {
  it("holds across the whole catalog", () => {
    const offenders: string[] = [];
    for (const modality of MODALITIES) {
      // The raw config rather than the projected catalog: the projection drops
      // models whose provider key this environment does not hold, and every
      // model shipped has to satisfy this whichever keys are set.
      const bucket = getFullModelConfig(modality) as {
        models?: Array<{
          name: string;
          mode: string | string[];
          params?: Record<string, unknown>;
        }>;
      };
      for (const model of bucket.models ?? []) {
        const declared = new Set(Object.keys(model.params ?? {}));
        const byMode = computeSourcesByMode(modality, model.mode);
        for (const [mode, sources] of Object.entries(byMode)) {
          for (const type of sources) {
            const carriers = FIELDS[type] ?? [];
            if (!carriers.some((field) => declared.has(field))) {
              offenders.push(
                `${model.name} (${mode}) needs ${type} but declares none of ${carriers.join("/")}`,
              );
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
