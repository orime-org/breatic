// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from "vitest";
import { noUpstreamFieldInCatalog } from "#repo-lint/checks/no-upstream-field-in-catalog";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const NAMES = JSON.stringify(["image_urls", "video_url"]);

/**
 * A catalog file holding one model with these params.
 * @param params - The param names.
 * @returns The yaml.
 */
function catalog(...params: string[]): string {
  return ["models:", '  - name: "m"', "    params:", ...params.flatMap((p) => [`      ${p}:`, '        fill: "panel"'])].join("\n");
}

describe("no-upstream-field-in-catalog", () => {
  it("passes a catalog whose params are our own names", () => {
    const context = fakeContext({
      "config/provider/upstream-field-names.json": NAMES,
      "config/models/image/models.yaml": catalog("images", "prompt_extend"),
    });
    expect(noUpstreamFieldInCatalog.run(context)).toEqual([]);
  });

  it("reports a param named as an upstream field, naming the model and the file", () => {
    const context = fakeContext({
      "config/provider/upstream-field-names.json": NAMES,
      "config/models/image/models.yaml": catalog("images"),
      "config/models/video/models.yaml": catalog("video_url", "duration"),
    });
    const findings = noUpstreamFieldInCatalog.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "config/models/video/models.yaml" });
    expect(findings[0]!.message).toContain("m.video_url");
  });
});
