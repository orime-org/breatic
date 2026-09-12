// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the media container hands back what it found (#209 + #210, design §4.2).
 *
 * Two things travel together and one of them is binary, so the answer is
 * multipart: a JSON part naming the streams and the duration, and a PNG part
 * when a frame was lifted. Building and reading it are asserted here, on both
 * sides of the same wire — the container writes it, the Worker reads it, and a
 * disagreement between the two shows up as a silently empty answer.
 */

import { describe, it, expect } from "vitest";
import { buildProbeAnswer, readProbeAnswer } from "@ingest/probe-answer.js";

const REPORT = {
  streams: [
    {
      index: 0,
      codecType: "video",
      codecName: "h264",
      width: 1280,
      height: 720,
      attachedPic: false,
    },
  ],
  durationSeconds: 60.5,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("an answer carrying a cover", () => {
  it("comes back with the report and the exact bytes that went in", async () => {
    const read = await readProbeAnswer(buildProbeAnswer(REPORT, PNG));

    expect(read.report).toEqual(REPORT);
    expect(read.cover).toEqual(PNG);
  });

  it("declares the cover as a PNG, which is what gets stored as its type", async () => {
    const answer = buildProbeAnswer(REPORT, PNG);
    const form = await answer.clone().formData();
    const cover = form.get("cover");

    expect(cover).toBeInstanceOf(File);
    expect((cover as File).type).toBe("image/png");
  });
});

describe("an answer with no cover", () => {
  it("carries the report alone", async () => {
    const read = await readProbeAnswer(buildProbeAnswer(REPORT, null));

    expect(read.report).toEqual(REPORT);
    expect(read.cover).toBeNull();
  });
});

describe("an answer the Worker cannot read", () => {
  it("reads a body that is not multipart as nothing found", async () => {
    const read = await readProbeAnswer(new Response("upstream fell over"));

    expect(read.report).toEqual({ streams: [], durationSeconds: null });
    expect(read.cover).toBeNull();
  });

  it("reads a multipart body with no report as nothing found", async () => {
    const form = new FormData();
    form.set("cover", new File([PNG], "cover.png", { type: "image/png" }));

    const read = await readProbeAnswer(new Response(form));

    expect(read.report).toEqual({ streams: [], durationSeconds: null });
    // Bytes with nothing saying what they are: a frame nobody can describe is
    // not a cover.
    expect(read.cover).toBeNull();
  });

  it("reads an unparsable report as nothing found", async () => {
    const form = new FormData();
    form.set("meta", "{ not json");

    const read = await readProbeAnswer(new Response(form));

    expect(read.report).toEqual({ streams: [], durationSeconds: null });
  });
});

// The header above promises totality, and `pickMediaMetadata` indexes
// `report.streams` the moment this returns. A meta part that parses to
// something else reaches that line, so the shape is what has to be judged —
// not whether the text was JSON.
describe("a meta part that parses to the wrong thing", () => {
  it.each([
    ["null", "null"],
    ["a number", "5"],
    ["an array", "[]"],
    ["an object with no streams", '{"durationSeconds":3}'],
    ["streams that are not a list", '{"streams":{},"durationSeconds":3}'],
  ])("reads %s as nothing found", async (_case, meta) => {
    const form = new FormData();
    form.set("meta", meta);

    const read = await readProbeAnswer(new Response(form));

    expect(read).toEqual({
      report: { streams: [], durationSeconds: null },
      cover: null,
    });
  });
});
