// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A join run inside the container (inner#1825 §6.4): the source downloads to
 * `source` and each further clip, in order, to `source-1`, `source-2` and on;
 * each is probed, and a clip the operation cannot join (a video join's clip
 * with no picture, an audio join's clip with no sound) fails the run as
 * `tool_failed` before anything is encoded. The operation's steps then get
 * every clip's path and probe in joining order.
 *
 * ffmpeg and ffprobe are not what is under test: the commands are stood in
 * for, the probes are answered from a table by file name, and the Worker's
 * reads, writes and report are a stubbed `fetch`.
 */

import { basename } from "node:path";
import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProbeReport } from "@ingest/media-metadata.js";
import type * as probeCommand from "@ingest/probe-command.js";
import type * as opArgs from "@ingest/jobs/op-args.js";

const h = vi.hoisted(() => {
  /** The probe each local file answers with, by its file name. */
  const probes: Record<string, unknown> = {};
  return {
    probes,
    /** Every file ffprobe was run on, in order. */
    probed: [] as string[],
    opSteps: vi.fn(),
    runSteps: vi.fn(),
  };
});

vi.mock("../run-steps.js", () => ({
  runCommand: async (program: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> => {
    if (program !== "ffprobe") throw new Error(`${program} is not stood in for`);
    const file = args[0]!;
    h.probed.push(file);
    const probe = h.probes[basename(file)];
    if (probe === undefined) throw new Error(`no probe for ${file}`);
    return { stdout: Buffer.from(JSON.stringify(probe)), stderr: "" };
  },
  runSteps: h.runSteps,
  cpuUsec: async (): Promise<number | null> => 1_000,
}));

vi.mock("@ingest/probe-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof probeCommand>()),
  probeArgs: (file: string): string[] => [file],
  readProbeOutput: (stdout: string): unknown => JSON.parse(stdout),
}));

vi.mock("@ingest/jobs/op-args.js", async (importOriginal) => ({
  ...(await importOriginal<typeof opArgs>()),
  opSteps: h.opSteps,
}));

const { runJob } = await import("../mini-tool-run.js");

const OBJECTS = "http://r2.local";
const REPORT = "http://jobs.local/report";

/** What the stubbed Worker was sent. */
let sent: { gets: string[]; reports: Record<string, unknown>[] };

/**
 * A video clip's probe.
 * @param sound - Whether it carries sound.
 * @param picture - Whether it carries a picture.
 * @param duration - Its length.
 * @returns The probe.
 */
function video(sound = true, picture = true, duration = 4): ProbeReport {
  return {
    streams: [
      ...(picture ? [{ index: 0, codecType: "video", codecName: "h264", width: 640, height: 360, attachedPic: false }] : []),
      ...(sound ? [{ index: 1, codecType: "audio", codecName: "aac", width: null, height: null, attachedPic: false, sampleRate: 48000, channels: 2 }] : []),
    ],
    durationSeconds: duration,
  };
}

/**
 * An audio clip's probe.
 * @param sound - Whether it carries sound.
 * @returns The probe.
 */
function audio(sound = true): ProbeReport {
  return {
    streams: sound ? [{ index: 0, codecType: "audio", codecName: "mp3", width: null, height: null, attachedPic: false, sampleRate: 44100, channels: 2 }] : [],
    durationSeconds: 6,
  };
}

/**
 * A join job's run body.
 * @param op - `join` or `audio_join`.
 * @param clips - How many clips follow the source.
 * @returns The body.
 */
function joinBody(op: "join" | "audio_join", clips: number): Parameters<typeof runJob>[0] {
  const ext = op === "join" ? "mp4" : "m4a";
  return {
    op,
    params: { crossfade: 0 },
    input: `${OBJECTS}/media/a.${ext}`,
    extra: Array.from({ length: clips }, (_, i) => `${OBJECTS}/media/clip-${i + 1}.${ext}`),
    outputs: [{ url: `${OBJECTS}/media/out.${ext}`, key: `media/out.${ext}` }],
    reportUrl: REPORT,
  } as unknown as Parameters<typeof runJob>[0];
}

/**
 * The last report the run sent.
 * @returns It.
 */
function lastReport(): Record<string, unknown> {
  const report = sent.reports.at(-1);
  if (report === undefined) throw new Error("the run sent no report");
  return report;
}

beforeEach(() => {
  sent = { gets: [], reports: [] };
  h.probed.length = 0;
  h.probes = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.opSteps.mockReset().mockImplementation((_op: string, _params: unknown, _input: string, output: string) => [
    { kind: "run", program: "ffmpeg", args: [output] },
  ]);
  // The run writes the file its last step names.
  h.runSteps.mockReset().mockImplementation(async (steps: { args: string[] }[]) => {
    await writeFile(steps.at(-1)!.args.at(-1)!, "out");
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      sent.gets.push(url);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } });
    }
    if (method === "POST" && url === REPORT) {
      sent.reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runJob — a join", () => {
  it("downloads each further clip after the source, to source-1, source-2, in order", async () => {
    h.probes = { source: video(), "source-1": video(), "source-2": video(), "out.mp4": video() };

    await runJob(joinBody("join", 2));

    expect(sent.gets).toEqual([`${OBJECTS}/media/a.mp4`, `${OBJECTS}/media/clip-1.mp4`, `${OBJECTS}/media/clip-2.mp4`]);
    expect(h.probed.slice(0, 3).map((file) => basename(file))).toEqual(["source", "source-1", "source-2"]);
    expect(lastReport()).toMatchObject({ ok: true });
  });

  it("hands the operation every further clip's path and probe in joining order", async () => {
    const second = video(false, true, 7);
    const third = video(true, true, 9);
    h.probes = { source: video(), "source-1": second, "source-2": third, "out.mp4": video() };

    await runJob(joinBody("join", 2));

    const [op, , input, , dir, source, extra] = h.opSteps.mock.calls[0]! as [string, unknown, string, string, string, ProbeReport, { path: string; probe: ProbeReport }[]];
    expect(op).toBe("join");
    expect(input).toBe(`${dir}/source`);
    expect(source).toEqual(video());
    expect(extra).toEqual([
      { path: `${dir}/source-1`, probe: second },
      { path: `${dir}/source-2`, probe: third },
    ]);
  });

  it("fails as tool_failed, encoding nothing, when a clip of a video join has no picture", async () => {
    h.probes = { source: video(), "source-1": video(), "source-2": video(true, false), "out.mp4": video() };

    await runJob(joinBody("join", 2));

    expect(lastReport()).toMatchObject({ ok: false, reason: "tool_failed" });
    expect(h.runSteps).not.toHaveBeenCalled();
  });

  it("fails as tool_failed, encoding nothing, when a clip of an audio join has no sound", async () => {
    h.probes = { source: audio(), "source-1": audio(false), "out.m4a": audio() };

    await runJob(joinBody("audio_join", 1));

    expect(lastReport()).toMatchObject({ ok: false, reason: "tool_failed" });
    expect(h.runSteps).not.toHaveBeenCalled();
  });

  it("joins a video clip that has no sound", async () => {
    h.probes = { source: video(), "source-1": video(false), "out.mp4": video() };

    await runJob(joinBody("join", 1));

    expect(lastReport()).toMatchObject({ ok: true });
  });
});

describe("runJob — one input", () => {
  // A run body from a job with no further inputs runs as it always did.
  it("downloads only the source and hands the operation no further clip", async () => {
    h.probes = { source: video(), "out.mp4": video() };
    const body = { ...joinBody("join", 0), op: "cut", params: { range: { start: 0, end: 2 } } } as Record<string, unknown>;
    delete body.extra;

    await runJob(body as unknown as Parameters<typeof runJob>[0]);

    expect(sent.gets).toEqual([`${OBJECTS}/media/a.mp4`]);
    expect(lastReport()).toMatchObject({ ok: true });
    expect(h.opSteps.mock.calls[0]![6] ?? []).toEqual([]);
  });
});
