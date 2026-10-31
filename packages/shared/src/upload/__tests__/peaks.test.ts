// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { AUDIO_PEAK_COUNT, AUDIO_PEAK_MAX } from "@shared/audio-peaks.js";
import {
  audioPeaksSchema,
  peaksKeyFor,
  peaksUrlFor,
} from "@shared/upload/peaks.js";

const BASE = "https://resource-dev.breatic.cc";
const UUID = "18f58aed-b802-4243-a8ea-02d377de9679";
const AUDIO_KEY = `audio/2026-10-21/1792580000000_${UUID}.mp3`;

describe("peaksKeyFor", () => {
  it("appends the peaks suffix to a stored key", () => {
    expect(peaksKeyFor(AUDIO_KEY)).toBe(`${AUDIO_KEY}.peaks.json`);
  });
});

describe("peaksUrlFor", () => {
  it("gives the peaks address of a stored audio object", () => {
    expect(peaksUrlFor(`${BASE}/${AUDIO_KEY}`)).toBe(`${BASE}/${AUDIO_KEY}.peaks.json`);
  });

  it("gives nothing for an address that names no stored object", () => {
    expect(peaksUrlFor("https://example.com/song.mp3")).toBeNull();
    expect(peaksUrlFor("blob:https://app/123")).toBeNull();
  });

  it("gives nothing for a peaks address itself", () => {
    expect(peaksUrlFor(`${BASE}/${AUDIO_KEY}.peaks.json`)).toBeNull();
  });
});

describe("audioPeaksSchema", () => {
  it("holds at most 1000 whole values from 0 to 255", () => {
    expect(AUDIO_PEAK_COUNT).toBe(1000);
    expect(AUDIO_PEAK_MAX).toBe(255);
  });

  it("accepts a file the container writes", () => {
    expect(audioPeaksSchema.safeParse({ version: 1, peaks: [0, 12, 255] }).success).toBe(true);
    expect(
      audioPeaksSchema.safeParse({ version: 1, peaks: Array.from({ length: 1000 }, () => 3) }).success,
    ).toBe(true);
  });

  it("refuses a file that is not the one it names", () => {
    const refused = [
      { version: 2, peaks: [1] },
      { version: 1, peaks: [] },
      { version: 1, peaks: [256] },
      { version: 1, peaks: [-1] },
      { version: 1, peaks: [1.5] },
      { version: 1, peaks: Array.from({ length: 1001 }, () => 1) },
      { version: 1 },
      null,
    ];
    for (const value of refused) expect(audioPeaksSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});
