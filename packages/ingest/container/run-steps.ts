// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Running an operation's steps in the container (inner#1305 §7.1): one
 * command at a time, commands joined stdout to stdin, or a measuring run whose
 * stderr decides what runs next. A pipe writes nothing between its commands,
 * so the disk holds only the source and the output.
 */

import { execFile, spawn } from "node:child_process";

import type { Command, RunStep } from "@ingest/jobs/op-args.js";

/** The most a measuring run's stderr, or a failing command's, is kept to. */
const STDERR_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Run one command to completion.
 * @param command - The program and its arguments.
 * @returns What it wrote to stderr.
 * @throws {Error} When it exits other than 0. It has no time of its own: the
 *   job's deadline ends the container (inner#1367).
 */
function runOne(command: Command): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.program, command.args, { encoding: "utf8", maxBuffer: STDERR_MAX_BYTES }, (error, _stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command.program} failed: ${error.message} ${stderr.slice(0, 2000)}`));
        return;
      }
      resolve(stderr);
    });
  });
}

/**
 * Run commands joined stdout to stdin, all at once.
 * @param commands - The commands, in order.
 * @returns Nothing.
 * @throws {Error} When any of them exits other than 0.
 */
async function runPipe(commands: readonly Command[]): Promise<void> {
  const children = commands.map((command, index) =>
    spawn(command.program, command.args, {
      stdio: [index === 0 ? "ignore" : "pipe", index === commands.length - 1 ? "ignore" : "pipe", "pipe"],
    }),
  );
  children.forEach((child, index) => {
    const next = children[index + 1];
    // A reader that stops early closes its stdin; the writer then sees EPIPE,
    // and its own exit status is what says whether that mattered.
    if (next?.stdin && child.stdout) {
      child.stdout.pipe(next.stdin);
      next.stdin.on("error", () => {});
    }
  });
  const exits = children.map(
    (child, index) =>
      new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          const command = commands[index]!;
          if (code === 0) resolve();
          else reject(new Error(`${command.program} in a pipe exited ${code ?? signal}: ${stderr.slice(0, 2000)}`));
        });
      }),
  );
  const settled = await Promise.allSettled(exits);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

/**
 * Run an operation's steps in order.
 * @param steps - The steps.
 * @returns Nothing.
 * @throws {Error} When a step fails.
 */
export async function runSteps(steps: readonly RunStep[]): Promise<void> {
  for (const step of steps) {
    switch (step.kind) {
      case "run":
        await runOne(step);
        break;
      case "pipe":
        await runPipe(step.commands);
        break;
      case "measure":
        await runSteps(step.then(await runOne(step)));
        break;
    }
  }
}
