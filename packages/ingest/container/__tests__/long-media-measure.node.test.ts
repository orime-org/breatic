// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeArgs, type ReadFrom } from "@ingest/probe-command.js";
import { buildLongMediaProbeReport } from "@ingest/long-media-probe-report.js";
import * as probeOwner from "../long-media-probe.js";
import type { LongMediaProbeRunResult } from "../long-media-probe.js";

let dir: string;

/**
 * Write one FFmpeg fixture.
 * @param name - The file name.
 * @param args - FFmpeg arguments before the output path.
 * @returns Its path.
 */
function make(name: string, args: string[]): string {
  const path = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, path]);
  return path;
}

/**
 * The probe this container runs first, on a local file.
 * @param path - The fixture.
 * @returns FFprobe's JSON.
 */
function probed(path: string): string {
  return execFileSync("ffprobe", probeArgs(path, "own-file")).toString("utf8");
}

/**
 * The measuring entry, read at call time so its absence fails each case on its own.
 * @returns It.
 */
function measure(): (objectUrl: string, stdout: string, signal: AbortSignal, from: ReadFrom) => Promise<{ index: number; start: { numerator: string; denominator: string }; end: { numerator: string; denominator: string } }[]> {
  const value: unknown = Reflect.get(probeOwner, "measureLongMediaStreams");
  expect(value, "measureLongMediaStreams is exported").toBeTypeOf("function");
  return value as never;
}

/**
 * An exact time in seconds as a number, for range assertions.
 * @param time - The time.
 * @param time.numerator - Its numerator.
 * @param time.denominator - Its denominator.
 * @returns Seconds.
 */
function seconds(time: { numerator: string; denominator: string }): number {
  return Number(time.numerator) / Number(time.denominator);
}

const video3s = ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=3"];
const sine3s = ["-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=3"];
let avWebm: string;
let opusWebm: string;
let aacMp4: string;
let avMkv: string;
let mp3: string;
let wav: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "long-media-measure-"));
  avWebm = make("av.webm", [...video3s, ...sine3s, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-shortest"]);
  opusWebm = make("opus.webm", [...sine3s, "-c:a", "libopus"]);
  // FFmpeg's MP4 muxer writes the moov box after the media data unless asked for faststart.
  aacMp4 = make("av.mp4", [...video3s, ...sine3s, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
  avMkv = make("av.mkv", [...video3s, ...sine3s, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
  mp3 = make("a.mp3", [...sine3s, "-c:a", "libmp3lame"]);
  wav = make("a.wav", [...sine3s, "-c:a", "pcm_s16le"]);
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("measuring the streams of a long-media source that declare no duration", () => {
  it("measures the video from its packets and the audio from its decoded frames in a WebM", async () => {
    const stdout = probed(avWebm);
    const measured = await measure()(avWebm, stdout, AbortSignal.timeout(60_000), "own-file");

    expect(measured.map(({ index }) => index).sort()).toEqual([0, 1]);
    const video = measured.find(({ index }) => index === 0)!;
    const audio = measured.find(({ index }) => index === 1)!;
    expect(seconds(video.start)).toBe(0);
    expect(seconds(video.end)).toBe(3);
    // Decoding drops the Opus pre-skip, so the audio starts at 0 and ends near 3 s rather than at its packets' 3.014 s.
    expect(seconds(audio.start)).toBe(0);
    expect(seconds(audio.end)).toBeGreaterThan(2.99);
    expect(seconds(audio.end)).toBeLessThan(3.01);
    const report = buildLongMediaProbeReport(stdout, "e".repeat(64), "whole-file-v1", measured);
    expect(report.mediaInputs[0]!.sourceRange.startUs).toBe("0");
  });

  it("measures an audio-only WebM from its decoded frames", async () => {
    const measured = await measure()(opusWebm, probed(opusWebm), AbortSignal.timeout(60_000), "own-file");
    expect(measured).toHaveLength(1);
    expect(seconds(measured[0]!.end)).toBeGreaterThan(2.99);
  });

  it("measures nothing for an MP4 whose streams declare their durations", async () => {
    await expect(measure()(aacMp4, probed(aacMp4), AbortSignal.timeout(60_000), "own-file")).resolves.toEqual([]);
  });
});

/**
 * Serve one file over HTTP, closing the first response's connection after part of its body while declaring the full
 * length, as an R2 or outbound stream reset does. A resumable server offers byte ranges and answers the reconnect's Range
 * request in full; one that offers none drops every response the same way.
 * @param path - The file.
 * @param fraction - The share of the body the first response sends.
 * @param resumable - Whether the server offers byte ranges.
 * @returns The server and the file's URL.
 */
async function serveDroppingOnce(path: string, fraction: number, resumable: boolean): Promise<{ server: Server; url: string }> {
  const bytes = readFileSync(path);
  let first = true;
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-/.exec(request.headers.range ?? "");
    const from = range === null ? 0 : Number(range[1]);
    const headers: Record<string, string | number> = { "content-type": "video/webm", "content-length": bytes.length - from };
    if (resumable) headers["accept-ranges"] = "bytes";
    if (range !== null) headers["content-range"] = `bytes ${from}-${bytes.length - 1}/${bytes.length}`;
    response.writeHead(range === null ? 200 : 206, headers);
    if (first || !resumable) {
      first = false;
      response.write(bytes.subarray(0, Math.floor(bytes.length * fraction)), () => request.socket.destroy());
      return;
    }
    response.end(bytes.subarray(from));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/source.webm` };
}

/**
 * Measure the audio-only WebM's streams on a file served by {@link serveDroppingOnce}.
 * @param path - The file served.
 * @param fraction - The share of the body the first response sends.
 * @param resumable - Whether the server offers byte ranges.
 * @returns The measured windows.
 */
async function measureServed(path: string, fraction: number, resumable: boolean): Promise<Awaited<ReturnType<ReturnType<typeof measure>>>> {
  const { server, url } = await serveDroppingOnce(path, fraction, resumable);
  try {
    return await measure()(url, probed(opusWebm), AbortSignal.timeout(60_000), "object");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("measuring a served source whose connection drops mid-body", () => {
  it("measures a whole served Opus WebM, whatever FFmpeg logs at its end", async () => {
    const measured = await measureServed(opusWebm, 1, true);
    expect(seconds(measured[0]!.end)).toBeGreaterThan(2.99);
  });

  it("resumes the read and measures the whole source", async () => {
    const measured = await measureServed(opusWebm, 0.6, true);
    expect(seconds(measured[0]!.end)).toBeGreaterThan(2.99);
  });

  it("fails rather than take the part read before the drop as the source's length", async () => {
    await expect(measureServed(opusWebm, 0.6, false)).rejects.toThrow(/read failed/);
  });
});

/**
 * Run the whole long-media probe (its own first probe, measuring and report) on a file served over HTTP. The first answer
 * closes its connection after `dropAt` body bytes while declaring the full length, as an R2 or outbound stream reset
 * does; every later answer is whole, and a server that offers byte ranges answers a Range request from where it asks.
 * @param path - The file.
 * @param dropAt - Where the first answer's body stops, or null for no drop.
 * @param ranges - Whether the server offers byte ranges.
 * @returns What the probe reported.
 */
async function probeServed(path: string, dropAt: number | null, ranges: boolean): Promise<LongMediaProbeRunResult> {
  const bytes = readFileSync(path);
  let dropping = dropAt !== null;
  let reported: LongMediaProbeRunResult | undefined;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => { reported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as LongMediaProbeRunResult; response.end(); });
      return;
    }
    const range = ranges ? /^bytes=(\d+)-/.exec(request.headers.range ?? "") : null;
    const from = range === null ? 0 : Number(range[1]);
    const headers: Record<string, string | number> = { "content-type": "application/octet-stream", "content-length": bytes.length - from };
    if (ranges) headers["accept-ranges"] = "bytes";
    if (range !== null) headers["content-range"] = `bytes ${from}-${bytes.length - 1}/${bytes.length}`;
    response.writeHead(range === null ? 200 : 206, headers);
    if (dropping) {
      dropping = false;
      response.write(bytes.subarray(from, dropAt!), () => request.socket.destroy());
      return;
    }
    response.end(bytes.subarray(from));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await probeOwner.runLongMediaProbe({ objectUrl: `${origin}/source`, reportUrl: `${origin}/report`, deadlineAt: Date.now() + 60_000 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(reported, "the probe reported").toBeDefined();
  return reported!;
}

const FINGERPRINT = "e".repeat(64);

/**
 * The report the Worker builds from a probe's answer, or `refused` when the answer is a failure or the Worker refuses it.
 * @param result - What the probe reported.
 * @returns The report, or `refused`.
 */
function reportOf(result: LongMediaProbeRunResult): ReturnType<typeof buildLongMediaProbeReport> | "refused" {
  if ("failure" in result) return "refused";
  try {
    return buildLongMediaProbeReport(result.stdout, FINGERPRINT, "whole-file-v1", result.measured ?? []);
  } catch {
    return "refused";
  }
}

/**
 * The report a probe of the local file gives, which no network read can disturb.
 * @param path - The file.
 * @returns The report.
 */
async function localReport(path: string): Promise<ReturnType<typeof buildLongMediaProbeReport>> {
  const stdout = probed(path);
  return buildLongMediaProbeReport(stdout, FINGERPRINT, "whole-file-v1", await measure()(path, stdout, AbortSignal.timeout(60_000), "own-file"));
}

/**
 * Where an MP4's top-level moov box starts and ends.
 * @param path - The file.
 * @returns Its byte range.
 */
function moovBox(path: string): { start: number; end: number } {
  const bytes = readFileSync(path);
  for (let at = 0; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(at);
    if (bytes.toString("latin1", at + 4, at + 8) === "moov") return { start: at, end: at + size };
    at += size;
  }
  throw new Error("The fixture has no moov box");
}

/**
 * The drop points inside a source's header: every 256 bytes of a trailing moov box, every 1024 bytes of a Matroska
 * file's first 16 KiB (its header and first cluster, which FFprobe reads to find each stream's parameters).
 * @param path - The file.
 * @returns The offsets.
 */
function headerDropPoints(path: string): number[] {
  const { start, end } = path.endsWith(".mp4") ? moovBox(path) : { start: 0, end: 16_384 };
  const step = path.endsWith(".mp4") ? 256 : 1024;
  const points: number[] = [];
  for (let at = start + step; at < end; at += step) points.push(at);
  return points;
}

describe("probing a served source whose connection drops inside its header", () => {
  it("serves an MP4 fixture whose moov box follows its media data", () => {
    expect(moovBox(aacMp4).start).toBeGreaterThan(readFileSync(aacMp4).length / 2);
  });

  it.each([
    ["a moov-at-end MP4", () => aacMp4],
    ["a WebM", () => avWebm],
    ["a Matroska file", () => avMkv],
  ])("resumes %s and reports what the whole source holds", async (_name, source) => {
    const path = source();
    const expected = await localReport(path);
    const wrong: string[] = [];
    for (const at of headerDropPoints(path)) {
      const got = reportOf(await probeServed(path, at, true));
      if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${at}: ${JSON.stringify(got === "refused" ? got : got.streams)}`);
    }
    expect(wrong, `expected ${JSON.stringify(expected.streams)}`).toEqual([]);
  }, 300_000);

  it.each([
    ["a moov-at-end MP4", () => aacMp4],
    ["a WebM", () => avWebm],
    ["a Matroska file", () => avMkv],
  ])("fails on %s rather than report the part read before a drop it cannot resume", async (_name, source) => {
    const path = source();
    const expected = await localReport(path);
    const wrong: string[] = [];
    for (const at of headerDropPoints(path)) {
      const got = reportOf(await probeServed(path, at, false));
      if (got !== "refused" && JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${at}: ${JSON.stringify(got.streams)}`);
    }
    expect(wrong, `expected a refusal or ${JSON.stringify(expected.streams)}`).toEqual([]);
  }, 300_000);
});

describe("probing a whole served source", () => {
  it.each([
    ["a moov-at-end MP4, both streams", () => aacMp4],
    ["an MP3", () => mp3],
    ["a WAV", () => wav],
  ])("reports %s as a probe of the local file does", async (_name, source) => {
    const path = source();
    const got = reportOf(await probeServed(path, null, true));
    expect(got).toEqual(await localReport(path));
  }, 120_000);

  it("trims an MP3's LAME end padding, as a seekable read of the local file does", async () => {
    const got = reportOf(await probeServed(mp3, null, true));
    expect(got).not.toBe("refused");
    expect((got as Exclude<typeof got, "refused">).mediaInputs[0]!.sourceRange).toEqual({ startUs: "23021", endUs: "3023021" });
  }, 120_000);
});

describe("measuring a truncated source", () => {
  it("measures what a served WebM cut short holds, as before", async () => {
    const cut = join(dir, "cut.webm");
    const bytes = readFileSync(opusWebm);
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    const measured = await measureServed(cut, 1, true);
    expect(seconds(measured[0]!.end)).toBeGreaterThan(1);
    expect(seconds(measured[0]!.end)).toBeLessThan(2.5);
  });
});
