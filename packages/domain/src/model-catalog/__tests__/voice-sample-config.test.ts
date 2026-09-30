// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #2239 — every deployment plays the voice samples from one fixed public
 * address, the one `config/voice-samples.json` names.
 */

import { describe, it, expect } from "vitest";

import {
  getVoiceSampleConfig,
  parseVoiceSampleConfig,
  voiceSampleUrl,
} from "@domain/model-catalog/voice-sample-config.js";

const VALID = {
  base_url: "https://samples.test",
  languages: { en: { text: "Hello." } },
  extra_body: {},
};

describe("parseVoiceSampleConfig", () => {
  it("reads the address, the sentences and the per-model extras", () => {
    expect(parseVoiceSampleConfig(VALID)).toEqual(VALID);
  });

  it("refuses an address that is not https or ends in a slash", () => {
    for (const base_url of ["http://samples.test", "https://samples.test/", "", undefined]) {
      expect(() => parseVoiceSampleConfig({ ...VALID, base_url }), String(base_url)).toThrow(
        "config/voice-samples.json: `base_url` must be an https address without a trailing slash",
      );
    }
  });

  it("refuses a file without sentences or extras", () => {
    expect(() => parseVoiceSampleConfig({ base_url: VALID.base_url })).toThrow(
      "config/voice-samples.json needs `languages` and `extra_body` objects",
    );
  });

  it("refuses a language without a sentence", () => {
    expect(() => parseVoiceSampleConfig({ ...VALID, languages: { ja: {} } })).toThrow(
      'config/voice-samples.json: language "ja" needs a text',
    );
  });
});

describe("voiceSampleUrl", () => {
  it("puts a sample key under the configured address", () => {
    const { base_url } = getVoiceSampleConfig();
    expect(voiceSampleUrl("voice-samples/m/ja/a.mp3")).toBe(`${base_url}/voice-samples/m/ja/a.mp3`);
  });

  it("is the address the samples were uploaded to", () => {
    expect(getVoiceSampleConfig().base_url).toBe("https://resource-dev.breatic.cc");
  });
});
