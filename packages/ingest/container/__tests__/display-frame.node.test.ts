// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePlanDisplayFrame, type PlanRecipeRequest } from "@ingest/container/plan-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";

vi.mock("@ingest/container/plan-command.js", () => ({ runPlanCommand: vi.fn() }));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const anchor = { frameIndex: 1, pts: 0.25 };
let request: PlanRecipeRequest;
let directory: string;
let output: string;

beforeEach(async () => {
  vi.resetAllMocks(); directory = await mkdtemp(join(tmpdir(), "display-anchor-unit-")); output = join(directory, "anchor.png");
  request = {
    recipe: { kind: "inspect_video", inputId: "10000000-0000-4000-8000-000000000001" },
    input: join(directory, "source.mov"), output: join(directory, "analysis.txt"), directory,
    facts: { source: { width: 400, height: 200, rotation: 90, hasAudio: false, timeBase: "1/4",
      frameTable: { frames: [{ frameIndex: 0, pts: 0 }, anchor], videoEnd: 0.5 } }, raw: { unchanged: "original-probe" } },
    signal: new AbortController().signal, limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
  };
  await writeFile(request.input, "original-source"); await writeFile(request.output, "original-analysis");
  vi.mocked(runPlanCommand).mockImplementation(async (_program, args) => { await writeFile(args.at(-1)!, png); return Buffer.alloc(0); });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("selected display anchor preparation with process IO mocked", () => {
  it("selects the original ordinal, delegates autorotation, and reads actual output geometry", async () => {
    const facts = structuredClone(request.facts);
    expect(await preparePlanDisplayFrame(request, anchor, output)).toEqual({ path: output, width: 1, height: 1, anchor });
    const [program, args, options] = vi.mocked(runPlanCommand).mock.calls[0]!;
    expect(program).toBe("ffmpeg"); expect(args[args.indexOf("-i") + 1]).toBe(request.input);
    expect(args[args.indexOf("-vf") + 1]).toBe("select=eq(n\\,1)");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args).not.toContain("-noautorotate"); expect(args).not.toContain("-ss"); expect(args).not.toContain("-r");
    expect(options).toEqual({ signal: request.signal, stdoutBytes: request.limits.probeStdoutBytes, stderrTailBytes: request.limits.stderrTailBytes });
    expect(request.facts).toEqual(facts); expect(await readFile(request.input, "utf8")).toBe("original-source");
    expect(await readFile(request.output, "utf8")).toBe("original-analysis");
  });

  it.each([{ frameIndex: 0, pts: 0.25 }, { frameIndex: 1, pts: 0.3 }, { frameIndex: 2, pts: 0.5 }, { frameIndex: 1.5, pts: 0.25 }])("refuses an anchor outside its original ledger: $frameIndex/$pts", async (value) => {
    await expect(preparePlanDisplayFrame(request, value, output)).rejects.toThrow("Display anchor differs from the original source ledger");
    expect(runPlanCommand).not.toHaveBeenCalled();
  });

  it("honors an already cancelled original lifetime before any process or file write", async () => {
    const controller = new AbortController(); const error = new DOMException("original task cancelled", "AbortError"); controller.abort(error);
    await expect(preparePlanDisplayFrame({ ...request, signal: controller.signal }, anchor, output)).rejects.toBe(error);
    expect(runPlanCommand).not.toHaveBeenCalled();
  });

  it("preserves the actual subprocess failure", async () => {
    const error = new Error("decoder failed"); vi.mocked(runPlanCommand).mockRejectedValue(error);
    await expect(preparePlanDisplayFrame(request, anchor, output)).rejects.toBe(error);
  });

  it("rejects output that is not a complete PNG geometry", async () => {
    vi.mocked(runPlanCommand).mockImplementation(async () => { await writeFile(output, "invalid PNG"); return Buffer.alloc(0); });
    await expect(preparePlanDisplayFrame(request, anchor, output)).rejects.toThrow("Display anchor did not produce a complete PNG");
  });

  it("preserves a missing output file as an IO failure", async () => {
    vi.mocked(runPlanCommand).mockResolvedValue(Buffer.alloc(0));
    await expect(preparePlanDisplayFrame(request, anchor, output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
