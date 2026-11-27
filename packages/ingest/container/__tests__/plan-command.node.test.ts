// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPlanCommand, startPlanCommand } from "@ingest/container/plan-command.js";

const OPTIONS = { signal: new AbortController().signal, stdoutBytes: 1024, stderrTailBytes: 64 };

describe("planned command lifetime with actual Node children", () => {
  it("returns complete stdout after normal close", async () => {
    expect(await runPlanCommand(process.execPath, ["-e", "process.stdout.write('complete')"], OPTIONS)).toEqual(Buffer.from("complete"));
  });

  it("accepts a successful file-producing command with empty stdout", async () => {
    expect(await runPlanCommand(process.execPath, ["-e", "process.exit(0)"], OPTIONS)).toEqual(Buffer.alloc(0));
  });

  it("retains only the bounded stderr tail of a nonzero exit", async () => {
    await expect(runPlanCommand(process.execPath, ["-e", "require('node:fs').writeSync(2,'HEAD'+'A'.repeat(10000)+'TAIL');process.exit(3)"], OPTIONS)).rejects.toThrow(/3.*TAIL/s);
    try {
      await runPlanCommand(process.execPath, ["-e", "require('node:fs').writeSync(2,'HEAD'+'A'.repeat(10000)+'TAIL');process.exit(3)"], OPTIONS);
    } catch (error) {
      expect(String(error)).not.toContain("HEAD");
    }
  });

  it("fails a missing executable rather than returning empty success", async () => {
    await expect(runPlanCommand("/does-not-exist/plan-command", [], OPTIONS)).rejects.toThrow(/ENOENT/);
  });

  it("enforces stdout bounds and terminates an otherwise live child", async () => {
    await expect(runPlanCommand(process.execPath, ["-e", "process.stdout.write('12345');setTimeout(()=>{},30000)"], { ...OPTIONS, stdoutBytes: 4 })).rejects.toThrow(/stdout/i);
  });

  it("preserves an already-cancelled original lifetime before spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runPlanCommand("/does-not-exist/plan-command", [], { ...OPTIONS, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses a stderr tail bound of %s before spawning a streamed command", (stderrTailBytes) => {
    expect(() => startPlanCommand("/does-not-exist/plan-command", [], { ...OPTIONS, stderrTailBytes }, { stdout: true })).toThrow(RangeError);
  });

  it("keeps only the bounded stderr tail of a streamed command's nonzero exit", async () => {
    const pipe = startPlanCommand(process.execPath, ["-e", "require('node:fs').writeSync(2,'HEAD'+'A'.repeat(10000)+'TAIL');process.exit(3)"], OPTIONS, {});
    const error = await pipe.done.then(() => undefined, (failure: unknown) => failure);
    expect(String(error)).toMatch(/3.*TAIL/s);
    expect(String(error)).not.toContain("HEAD");
  });

  it("waits until its actual child PID is reaped after cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plan-process-unit-"));
    const marker = join(directory, "child.pid");
    const controller = new AbortController();
    const ready = new Promise<void>((resolve) => {
      watchFile(marker, { interval: 10 }, (stats) => { if (stats.size > 0) resolve(); });
    });
    const pending = runPlanCommand(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},30000)", marker], { ...OPTIONS, signal: controller.signal });
    const observed = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    try {
      await Promise.race([ready, pending.then(() => { throw new Error("Child closed before its marker"); })]);
      const pid = Number(await readFile(marker, "utf8"));
      controller.abort();
      const result = await observed;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ name: "AbortError" });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      unwatchFile(marker);
      await observed;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
