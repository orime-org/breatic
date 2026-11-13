// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from "vitest";
import { noUpstreamFieldInCatalog } from "#repo-lint/checks/no-upstream-field-in-catalog";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * A catalog file holding one model with these params.
 * @param params - The param names.
 * @returns The yaml.
 */
function catalog(...params: string[]): string {
  return ["models:", '  - name: "m"', "    params:", ...params.flatMap((p) => [`      ${p}:`, '        fill: "panel"'])].join("\n");
}

/** A provider media file: a binding sending `images` as `image_urls`, `seed` as itself and speakers' names as `speaker_id`. */
const BINDINGS = [
  "models:",
  "  m:",
  "    upstreams:",
  "      - upstream: fal",
  "        params:",
  "          images:",
  "            field: input.image_urls",
  "          seed:",
  "            field: seed",
  "          speakers:",
  "            field: speakers",
  "            item_fields:",
  "              speaker:",
  "                field: speaker_id",
  "              voice:",
  "                field: voice",
].join("\n");

describe("no-upstream-field-in-catalog", () => {
  it("passes a catalog whose params are our own names, the ones a binding sends as they are among them", () => {
    const context = fakeContext({
      "config/provider/media/image.yaml": BINDINGS,
      "config/models/image/models.yaml": catalog("images", "seed", "speakers", "prompt_extend"),
    });
    expect(noUpstreamFieldInCatalog.run(context)).toEqual([]);
  });

  it("reports a param named as a field a binding sends another param as, naming the model and the file", () => {
    const context = fakeContext({
      "config/provider/media/image.yaml": BINDINGS,
      "config/models/image/models.yaml": catalog("images"),
      "config/models/video/models.yaml": catalog("image_urls", "speaker_id", "duration"),
    });
    const findings = noUpstreamFieldInCatalog.run(context);
    expect(findings.map((f) => f.message)).toEqual([expect.stringContaining("m.image_urls"), expect.stringContaining("m.speaker_id")]);
    expect(findings[0]).toMatchObject({ file: "config/models/video/models.yaml" });
  });

  it("passes a name reviewed as ours that a binding happens to send another param as", () => {
    const context = fakeContext({
      "config/provider/media/video.yaml": ["models:", "  w:", "    upstreams:", "      - upstream: fal", "        params:", "          generate_audio:", "            field: audio"].join("\n"),
      "config/models/video/models.yaml": catalog("audio"),
    });
    expect(noUpstreamFieldInCatalog.run(context)).toEqual([]);
  });

  // The names come from the bindings alone: a catalog that took an upstream's field name cannot make it ours.
  it("reports the param however many catalog params share the name", () => {
    const context = fakeContext({
      "config/provider/media/image.yaml": BINDINGS,
      "config/models/image/models.yaml": catalog("image_urls"),
      "config/models/audio/models.yaml": catalog("image_urls"),
    });
    expect(noUpstreamFieldInCatalog.run(context)).toHaveLength(2);
  });
});
