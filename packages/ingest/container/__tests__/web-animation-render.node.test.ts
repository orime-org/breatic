// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The render container's verdict on the video the renderer wrote (#1490 design §6.2): what ffprobe measured must have
 * exactly the frame count, width and height the export froze, or the export fails as `frame_mismatch`.
 */

import { describe, expect, it } from "vitest";

import { judgeWebAnimationRender, markCompositionsWithoutTimeline, wholePercentProgress } from "../web-animation-render.js";

const EXPECTED = { durationFrames: 144, width: 1080, height: 1920 };

describe("judgeWebAnimationRender", () => {
  it("passes a video with the frozen frame count and size", () => {
    expect(judgeWebAnimationRender({ frames: 144, width: 1080, height: 1920 }, EXPECTED)).toBeNull();
  });

  it.each([
    ["one frame short", { frames: 143, width: 1080, height: 1920 }],
    ["one frame over", { frames: 145, width: 1080, height: 1920 }],
    ["the wrong width", { frames: 144, width: 1078, height: 1920 }],
    ["the wrong height", { frames: 144, width: 1080, height: 1918 }],
    ["no frames counted", { frames: null, width: 1080, height: 1920 }],
  ])("fails a video with %s as frame_mismatch", (_name, probe) => {
    expect(judgeWebAnimationRender(probe, EXPECTED)).toBe("frame_mismatch");
  });
});

describe("markCompositionsWithoutTimeline", () => {
  const PACKAGE = "<!doctype html>\n<html>\n<head><script>\nconst q = document.querySelector(\"[data-composition-id]\"); const s = \"<div data-composition-id>\";\n</script>\n" +
    "<!-- <div data-composition-id=\"x\"> -->\n</head>\n<body>\n<div id=\"main\" data-composition-id=\"main\" data-start=\"0\" data-duration=\"4\"><p>Logo</p></div>\n</body>\n</html>\n";

  it("marks the composition root so the producer does not wait for a timeline it never registers", () => {
    const marked = markCompositionsWithoutTimeline(PACKAGE);
    expect(marked).toContain("<div data-no-timeline id=\"main\" data-composition-id=\"main\"");
    expect(marked.match(/data-no-timeline/g)).toHaveLength(1);
  });

  it("marks every composition host, whatever its quoting, and leaves a marked one alone", () => {
    const html = "<body><section data-composition-id='main'><div class=a data-composition-id=b></div><i data-composition-id=\"c\" data-no-timeline></i></section></body>";
    expect(markCompositionsWithoutTimeline(html)).toBe(
      "<body><section data-no-timeline data-composition-id='main'><div data-no-timeline class=a data-composition-id=b></div><i data-composition-id=\"c\" data-no-timeline></i></section></body>",
    );
  });
});

describe("wholePercentProgress", () => {
  // The producer calls its progress sink as (job, stage) and keeps the whole percent, 0 to 100, on job.progress.
  it("reports the producer's job progress as a fraction once per whole percent", () => {
    const sent: number[] = [];
    const sink = wholePercentProgress((fraction) => sent.push(fraction));
    for (const progress of [0, 0, 25, 25, 26, 90, 99, 100]) sink({ progress }, "Encoding");
    expect(sent).toEqual([0, 0.25, 0.26, 0.9, 0.99, 1]);
  });

  it("ignores a job that carries no finite progress", () => {
    const sent: number[] = [];
    const sink = wholePercentProgress((fraction) => sent.push(fraction));
    sink({}, "Preparing");
    sink({ progress: Number.NaN }, "Preparing");
    expect(sent).toEqual([]);
  });
});
