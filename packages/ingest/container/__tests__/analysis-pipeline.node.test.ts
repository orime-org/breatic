// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as ChildProcesses from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, watchFile, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisPipelineError, runAnalysisPipeline, type AnalysisPipelineRequest } from "../analysis-pipeline.js";

const observed = vi.hoisted(() => ({ children: [] as Array<{
  child: ChildProcesses.ChildProcess;
  closed: boolean;
  close: Promise<void>;
}> }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcesses>();
  return { ...actual, spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    const record = { child, closed: false, close: Promise.resolve() };
    record.close = new Promise<void>((resolve) => child.once("close", () => {
      record.closed = true;
      resolve();
    }));
    observed.children.push(record);
    return child;
  }) };
});

type Outcome = { ok: true; value: string } | { ok: false; error: unknown };
type Fixture = Record<string, unknown>;
type Controls = {
  decoder: Record<"ready" | "written" | "release", string>;
  processor: Record<"ready" | "received" | "input" | "inputClosed" | "waiting" | "resultRelease" | "outputWritten" | "outputRelease" | "release", string>;
};
const original = ' {"frames":2}\n';
const bytes = Buffer.from(Array.from({ length: 24 }, (_, index) => index));
const fixture = fileURLToPath(new URL("./fixtures/analysis-process.mjs", import.meta.url));
let directory: string;
let sequence = 0;

beforeEach(async () => {
  observed.children.length = 0;
  directory = await mkdtemp(join(tmpdir(), "breatic-analysis-pipeline-"));
  sequence = 0;
});
afterEach(async () => {
  // Emergency cleanup runs after assertions; it is never evidence of success.
  for (const { child, closed } of observed.children) {
    if (!closed && child.pid !== undefined) child.kill("SIGKILL");
  }
  await Promise.all(observed.children.map(({ close }) => close));
  await rm(directory, { recursive: true, force: true });
});

/** Create independent fixture controls without reading any application environment. */
function prepare(decoder: Fixture = {}, processor: Fixture = {}): {
  request: AnalysisPipelineRequest; control: AbortController;
  paths: Controls;
} {
  const prefix = String(sequence++);
  const paths: Controls = {
    decoder: Object.fromEntries(["ready", "written", "release"].map((key) => [key, join(directory, `${prefix}-decoder-${key}`)])) as Controls["decoder"],
    processor: Object.fromEntries(["ready", "received", "input", "inputClosed", "waiting", "resultRelease", "outputWritten", "outputRelease", "release"].map((key) => [key, join(directory, `${prefix}-processor-${key}`)])) as Controls["processor"],
  };
  const control = new AbortController();
  return {
    control, paths,
    request: {
      decoder: { program: process.execPath, args: [fixture, JSON.stringify({ role: "decoder", ...paths.decoder, ...decoder })] },
      processor: { program: process.execPath, args: [fixture, JSON.stringify({ role: "processor", ...paths.processor, ...processor })] },
      width: 2, height: 2, expectedFrameCount: 2, signal: control.signal,
      limits: { stdoutBytes: 32, stderrTailBytes: 8 },
    },
  };
}

/** Keep rejected operations observed while tests wait for independent child markers. */
function begin(request: AnalysisPipelineRequest): Promise<Outcome> {
  return runAnalysisPipeline(request).then(
    (value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }),
  );
}

/** Wait on a child-written fact; an early operation failure fails the test immediately. */
async function marker(path: string, outcome: Promise<Outcome>): Promise<void> {
  let check: () => void = () => { /* Assigned before installing the polling watcher. */ };
  try {
    const written = new Promise<void>((resolve) => {
      check = () => { if (existsSync(path)) resolve(); };
      watchFile(path, { interval: 10 }, check);
      check();
    });
    await Promise.race([written, outcome.then((result) => { throw result.ok ? new Error("Pipeline settled before its fixture gate") : result.error; })]);
  } finally {
    unwatchFile(path, check);
  }
}

/** Assert actual close and PID disappearance, without terminating anything here. */
function assertReaped(count = 2): void {
  expect(observed.children).toHaveLength(count);
  for (const { child, closed } of observed.children) {
    expect(closed).toBe(true);
    const pid = child.pid;
    if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
  }
}

/** Extract a concrete failure instead of accepting an unspecified rejection. */
async function failure(outcome: Promise<Outcome>): Promise<AnalysisPipelineError> {
  const result = await outcome;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected pipeline failure");
  expect(result.error).toBeInstanceOf(AnalysisPipelineError);
  return result.error as AnalysisPipelineError;
}

describe("owned analysis process pipeline", () => {
  it.each([{ chunks: undefined }, { chunks: [1, 2, 4, 3, 2, 4, 8] }])("preserves exact BGR bytes and raw stdout with chunks $chunks", async ({ chunks }) => {
    const { request, paths } = prepare({ chunks });
    expect(await begin(request)).toEqual({ ok: true, value: original });
    expect(await readFile(paths.processor.input)).toEqual(bytes);
    assertReaped();
    expect(observed.children.map(({ child }) => [child.exitCode, child.signalCode])).toEqual([[0, null], [0, null]]);
  });

  it("waits for all input and both real closes even when output arrives first", async () => {
    const { request, paths } = prepare({ holdAt: 12 }, { earlyOutput: true });
    const outcome = begin(request);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await marker(paths.processor.outputWritten, outcome);
    await marker(paths.processor.received, outcome);
    expect(settled).toBe(false);
    expect(observed.children.map(({ closed }) => closed)).toEqual([false, false]);
    await writeFile(paths.decoder.release, "release");
    expect(await outcome).toEqual({ ok: true, value: original });
    assertReaped();
  });

  it.each([12, 17, 36])("rejects a ledger mismatch of %i bytes and reaps both children", async (length) => {
    const { request } = prepare({ bytes: length });
    const error = await failure(begin(request));
    expect(String(error.cause)).toMatch(/ledger/);
    assertReaped();
  });

  it("retains decoder exit 7 and its stderr even after complete frames", async () => {
    const { request } = prepare({ fail: true });
    const error = await failure(begin(request));
    expect(error.diagnostics[0]).toMatchObject({ stage: "decoder", exitCode: 7, stderrTail: "DEC-FAIL" });
    assertReaped();
  });

  it.each([false, true])("rejects early processor exit (nonzero=%s) and reaps the held decoder", async (fail) => {
    const { request } = prepare({ holdAt: 12 }, { earlyExit: true, fail });
    const error = await failure(begin(request));
    expect(error.diagnostics[1]).toMatchObject({ stage: "processor", exitCode: fail ? 9 : 0, stderrTail: fail ? "PRO-FAIL" : "" });
    assertReaped();
  });

  it.each(["decoder", "processor"] as const)("reaps created children when %s cannot spawn", async (stage) => {
    const { request } = prepare({ holdAt: 0 });
    request[stage] = { program: join(directory, "missing-program"), args: [] };
    const error = await failure(begin(request));
    expect(error.cause).toMatchObject({ code: "ENOENT" });
    assertReaped(stage === "decoder" ? 1 : 2);
  });

  it("reaps both processes after the real downstream input closes early", async () => {
    const { request, paths } = prepare({ holdAt: 12 }, { closeInput: true });
    const outcome = begin(request);
    await marker(paths.processor.inputClosed, outcome);
    await writeFile(paths.decoder.release, "release");
    const error = await failure(outcome);
    expect(String(error.cause)).toMatch(/premature|closed|pipe/i);
    assertReaped();
  });

  it("does not spawn after pre-cancellation", async () => {
    const { request, control } = prepare();
    control.abort();
    expect((await failure(begin(request))).name).toBe("AbortError");
    assertReaped(0);
  });

  it.each([7, 12])("cancels after the decoder has written %i controlled bytes", async (holdAt) => {
    const { request, control, paths } = prepare({ holdAt });
    const outcome = begin(request);
    await marker(paths.decoder.written, outcome);
    await marker(paths.processor.ready, outcome);
    if (holdAt === 12) await marker(paths.processor.received, outcome);
    else expect(existsSync(paths.processor.received)).toBe(false);
    control.abort();
    const error = await failure(outcome);
    expect(error.name).toBe("AbortError");
    expect(error.cause).toMatchObject({ name: "AbortError" });
    assertReaped();
  });

  it("cancels while only the processor remains alive", async () => {
    const { request, control, paths } = prepare({}, { holdResult: true });
    const outcome = begin(request);
    await marker(paths.processor.waiting, outcome);
    await observed.children[0]!.close;
    expect(observed.children[0]!.child.exitCode).toBe(0);
    control.abort();
    expect((await failure(outcome)).name).toBe("AbortError");
    assertReaped();
  });

  it("keeps another concurrent pipeline alive when one is cancelled", async () => {
    const a = prepare({ holdAt: 12 });
    const b = prepare({ holdAt: 12 });
    const first = begin(a.request);
    const second = begin(b.request);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await marker(a.paths.processor.received, first);
    await marker(b.paths.processor.received, second);
    const bChildren = observed.children.filter(({ child }) => child.spawnargs.includes(b.request.decoder.args[1]!) || child.spawnargs.includes(b.request.processor.args[1]!));
    a.control.abort();
    expect((await failure(first)).name).toBe("AbortError");
    expect(secondSettled).toBe(false);
    expect(bChildren).toHaveLength(2);
    expect(bChildren.map(({ closed, child }) => [closed, child.exitCode, child.signalCode])).toEqual([[false, null, null], [false, null, null]]);
    await writeFile(b.paths.decoder.release, "release");
    expect(await second).toEqual({ ok: true, value: original });
    assertReaped(4);
  });

  it.each(["S".repeat(32), "not-json\n"])("returns bounded raw output unchanged: %s", async (output) => {
    const { request } = prepare({}, { output });
    expect(await begin(request)).toEqual({ ok: true, value: output });
    assertReaped();
  });

  it.each(["S".repeat(33), "é".repeat(16) + "x"])("rejects output above the byte limit: %s", async (output) => {
    const { request } = prepare({}, { output, holdOutput: true });
    const error = await failure(begin(request));
    expect(String(error.cause)).toMatch(/stdout.*32/);
    assertReaped();
  });

  it("counts stdout across chunks and fails on byte 33", async () => {
    const { request, paths } = prepare({}, { splitOutput: true });
    const outcome = begin(request);
    await marker(paths.processor.outputWritten, outcome);
    await writeFile(paths.processor.outputRelease, "release");
    expect(String((await failure(outcome)).cause)).toMatch(/stdout.*32/);
    assertReaped();
  });

  it("drains both stderr floods without test observers consuming either pipe", async () => {
    const { request } = prepare({ flood: true }, { flood: true });
    expect(await begin(request)).toEqual({ ok: true, value: original });
    assertReaped();
  });

  it("retains exactly the bounded stderr tail on a real nonzero close", async () => {
    const { request } = prepare({}, { flood: true, fail: true });
    const error = await failure(begin(request));
    expect(error.diagnostics[1]).toMatchObject({ exitCode: 9, stderrTail: "PROC-END" });
    assertReaped();
  });

  it.each([{ label: "zero", value: 0 }, { label: "negative zero", value: -0 }])("accepts $label stdout limit for completely empty output", async ({ value }) => {
    const { request } = prepare({}, { output: "" });
    request.limits.stdoutBytes = value;
    expect(await begin(request)).toEqual({ ok: true, value: "" });
    assertReaped();
  });

  it("rejects the first stdout byte when the limit is zero", async () => {
    const { request } = prepare({}, { output: "X", holdOutput: true });
    request.limits.stdoutBytes = 0;
    expect(String((await failure(begin(request))).cause)).toMatch(/stdout.*0/);
    assertReaped();
  });

  it("continues draining both stderr floods with a zero tail budget", async () => {
    const { request } = prepare({ flood: true }, { flood: true });
    request.limits.stderrTailBytes = 0;
    expect(await begin(request)).toEqual({ ok: true, value: original });
    assertReaped();
  });

  it("retains exit 9 but no stderr bytes with a zero tail budget", async () => {
    const { request } = prepare({}, { flood: true, fail: true });
    request.limits.stderrTailBytes = 0;
    const error = await failure(begin(request));
    expect(error.diagnostics[1]).toMatchObject({ stage: "processor", exitCode: 9, stderrTail: "" });
    assertReaped();
  });

  it("combines empty stdout and draining stderr when both limits are zero", async () => {
    const { request } = prepare({ flood: true }, { flood: true, output: "" });
    request.limits = { stdoutBytes: 0, stderrTailBytes: 0 };
    expect(await begin(request)).toEqual({ ok: true, value: "" });
    assertReaped();
  });

  for (const field of ["stdoutBytes", "stderrTailBytes"] as const) {
    it(`accepts the maximum safe ${field} without preallocating that limit`, async () => {
      const { request } = prepare({}, { output: "" });
      request.limits[field] = 9007199254740991;
      expect(await begin(request)).toEqual({ ok: true, value: "" });
      assertReaped();
    });

    it.each([-1, -0.5, 0.5, 1.5, NaN, Infinity, -Infinity, 9007199254740992])(`rejects invalid ${field}=%s before spawning either child`, async (value) => {
      const { request } = prepare();
      request.limits[field] = value;
      const error = await failure(begin(request));
      expect(error.cause).toBeInstanceOf(RangeError);
      assertReaped(0);
    });
  }
});
