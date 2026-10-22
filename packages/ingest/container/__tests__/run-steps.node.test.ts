// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the container runs an operation's steps (inner#1305 §7.1). `sh`, `tr`
 * and `cat` stand in for ffmpeg and sox: what is under test is how one
 * command's output reaches the next, not the programs.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunStep } from "@ingest/jobs/op-args.js";
import { runSteps } from "../run-steps.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "run-steps-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A step running a stand-in program.
 * @param program - The stand-in.
 * @param args - Its arguments.
 * @returns The run step.
 */
function run(program: string, args: string[]): RunStep {
  return { kind: "run", program, args } as unknown as RunStep;
}

describe("runSteps", () => {
  it("runs single steps in order", async () => {
    const file = join(dir, "out.txt");
    await runSteps([run("sh", ["-c", `printf a > ${file}`]), run("sh", ["-c", `printf b >> ${file}`])]);
    expect(await readFile(file, "utf8")).toBe("ab");
  });

  it("feeds each command of a pipe the one before it, with nothing written between them", async () => {
    const file = join(dir, "out.txt");
    const pipe = {
      kind: "pipe",
      commands: [
        { program: "sh", args: ["-c", "printf abc"] },
        { program: "tr", args: ["a-z", "A-Z"] },
        { program: "sh", args: ["-c", `cat > ${file}`] },
      ],
    } as unknown as RunStep;
    await runSteps([pipe]);
    expect(await readFile(file, "utf8")).toBe("ABC");
  });

  it("fails the pipe when any command in it fails", async () => {
    const pipe = {
      kind: "pipe",
      commands: [
        { program: "sh", args: ["-c", "printf abc"] },
        { program: "sh", args: ["-c", "cat >/dev/null; exit 3"] },
        { program: "sh", args: ["-c", "cat >/dev/null"] },
      ],
    } as unknown as RunStep;
    await expect(runSteps([pipe])).rejects.toThrow();
  });

  // The writer fills the pipe buffer long before the reader is gone, so it
  // only ends when the reader's exit closes the pipe under it.
  it.each([
    ["the middle", [{ program: "sh", args: ["-c", "exit 3"] }, { program: "cat", args: [] }]],
    ["the last", [{ program: "cat", args: [] }, { program: "sh", args: ["-c", "exit 3"] }]],
  ])("fails the pipe at once when %s command exits while the first is still writing", async (_where, rest) => {
    const pipe = {
      kind: "pipe",
      commands: [{ program: "head", args: ["-c", "200000000", "/dev/zero"] }, ...rest],
    } as unknown as RunStep;
    await expect(runSteps([pipe])).rejects.toThrow();
  }, 5_000);

  it("hands a measure step's stderr to the steps it decides on", async () => {
    const file = join(dir, "out.txt");
    const measure = {
      kind: "measure",
      program: "sh",
      args: ["-c", "printf 'noise\\n{\"x\": 7}' >&2"],
      then: (stderr: string): RunStep[] => [run("sh", ["-c", `printf '${stderr.split("\n")[1]}' > ${file}`])],
    } as unknown as RunStep;
    await runSteps([measure]);
    expect(await readFile(file, "utf8")).toBe('{"x": 7}');
  });

  it("fails on a single step that fails", async () => {
    await expect(runSteps([run("sh", ["-c", "exit 1"])])).rejects.toThrow();
  });
});
