// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One container run that turns a picture upright (inner#1367 §4.4): turn it,
 * probe and preview the turned picture where it lies, then write it back with
 * its pixel size. Writing last is what lets a re-delivery of the finish answer
 * from the object alone.
 */

import { describe, expect, it } from "vitest";

import { runUpright, type UprightDeps } from "../upright-probe.js";
import type { UprightOrder } from "@ingest/upright-run.js";

const ORDER: UprightOrder = {
  writeUrl: "http://upright.local/image/2026-10-10/1_x_upright.jpg",
  contentType: "image/jpeg",
  lossless: false,
  quality: 90,
  maxBytes: 1024,
};

/** What ffprobe answers for a 3000x4000 picture. */
const PROBED = JSON.stringify({
  streams: [{ index: 0, codec_type: "video", codec_name: "mjpeg", width: 3000, height: 4000 }],
  format: {},
});

/** Deps that record every step and answer as told. */
function deps(over: Partial<{ turned: Buffer | null; writeStatus: number }> = {}): UprightDeps & {
  steps: string[];
  written: { url: string; headers: Record<string, string>; body: Uint8Array } | null;
} {
  const record = {
    steps: [] as string[],
    written: null as { url: string; headers: Record<string, string>; body: Uint8Array } | null,
  };
  const turned = "turned" in over ? over.turned! : Buffer.from("upright-bytes");
  return Object.assign(record, {
    openObject: async () => {
      record.steps.push("open");
      return new ReadableStream<Uint8Array>();
    },
    runTool: async (program: string, args: string[], run: { maxBytes: number }) => {
      if (program === "vips" && args[0] === "autorot") {
        record.steps.push(`turn:${run.maxBytes}`);
        return turned;
      }
      if (program === "ffprobe") {
        record.steps.push(`probe:${args.at(-1) ?? ""}`);
        return Buffer.from(PROBED);
      }
      record.steps.push("preview");
      return Buffer.from("webp");
    },
    writeTemp: async () => {
      record.steps.push("temp");
      return { path: "/tmp/upright/picture", remove: async () => { record.steps.push("cleanup"); } };
    },
    put: async (url: string, headers: Record<string, string>, body: Uint8Array) => {
      record.steps.push("write");
      record.written = { url, headers, body };
      return over.writeStatus ?? 200;
    },
  });
}

/** A run whose deadline is well ahead. */
const AHEAD = { wantPreview: true, deadlineAt: Date.now() + 60_000 };

describe("turning a picture upright in the container", () => {
  it("turns it, probes and previews the turned picture, and writes it back last", async () => {
    const d = deps();

    const ran = await runUpright("http://r2.local/k.jpg", ORDER, AHEAD, AbortSignal.timeout(60_000), d);

    expect(d.steps).toEqual([
      "open",
      `turn:${ORDER.maxBytes}`,
      "temp",
      "probe:/tmp/upright/picture",
      "preview",
      "write",
      "cleanup",
    ]);
    expect(ran.outcome).toEqual({ state: "written" });
    expect(ran.preview).toEqual(new Uint8Array(Buffer.from("webp")));
  });

  it("writes the turned bytes with the pixel size it measured on them", async () => {
    const d = deps();

    await runUpright("http://r2.local/k.jpg", ORDER, AHEAD, AbortSignal.timeout(60_000), d);

    expect(d.written).toEqual({
      url: ORDER.writeUrl,
      headers: { "x-upright-width": "3000", "x-upright-height": "4000" },
      body: new Uint8Array(Buffer.from("upright-bytes")),
    });
  });

  it("answers a failed turn, and writes nothing", async () => {
    const d = deps({ turned: null });

    const ran = await runUpright("http://r2.local/k.jpg", ORDER, AHEAD, AbortSignal.timeout(60_000), d);

    expect(ran.outcome).toEqual({ state: "failed", step: "turn" });
    expect(d.written).toBeNull();
  });

  it("answers a failed write when the write-back is refused", async () => {
    const d = deps({ writeStatus: 413 });

    const ran = await runUpright("http://r2.local/k.jpg", ORDER, AHEAD, AbortSignal.timeout(60_000), d);

    expect(ran.outcome).toEqual({ state: "failed", step: "write" });
  });

  it("leaves the preview out when the deadline has come, and still writes the picture", async () => {
    const d = deps();

    const ran = await runUpright(
      "http://r2.local/k.jpg",
      ORDER,
      { wantPreview: true, deadlineAt: Date.now() - 1 },
      AbortSignal.timeout(60_000),
      d,
    );

    expect(d.steps).not.toContain("preview");
    expect(ran.preview).toBeNull();
    expect(ran.outcome).toEqual({ state: "written" });
  });
});
