// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Running an operation's steps in the container (inner#1305 §7.1): one
 * command at a time, commands joined stdout to stdin, or a measuring run whose
 * stderr decides what runs next. A pipe writes nothing between its commands,
 * so the disk holds only the source and the output.
 */

import { execFile, spawn } from "node:child_process";
import { pipeline } from "node:stream";

import type { Command, RunStep } from "@ingest/jobs/op-args.js";

/** What a command wrote. */
export interface CommandOutput {
  stdout: Buffer;
  stderr: string;
}

/**
 * Run one program to completion.
 * @param program - The program.
 * @param args - Its arguments.
 * @param maxBytes - The most stdout or stderr may hold.
 * @returns What it wrote to stdout and stderr.
 * @throws {Error} When it exits other than 0 or writes too much. It has no
 *   time of its own: the job's deadline ends the container (inner#1367).
 */
export function runCommand(program: string, args: string[], maxBytes = 4 * 1024 * 1024): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { encoding: "buffer", maxBuffer: maxBytes }, (error, stdout, stderr) => {
      const text = stderr.toString("utf8");
      if (error !== null) {
        reject(new Error(`${program} failed: ${error.message} ${text.slice(0, 2000)}`));
        return;
      }
      resolve({ stdout, stderr: text });
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
    // A reader that exits closes its stdin; pipeline then closes the writer's
    // stdout too, so the writer gets SIGPIPE and exits in place of blocking
    // on a full pipe. Each exit status says how its command went.
    if (next?.stdin && child.stdout) pipeline(child.stdout, next.stdin, () => {});
  });
  const exits = children.map(
    (child, index) =>
      new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < 2000) stderr += chunk.toString("utf8");
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
        await runCommand(step.program, step.args);
        break;
      case "pipe":
        await runPipe(step.commands);
        break;
      case "measure":
        await runSteps(step.then((await runCommand(step.program, step.args)).stderr));
        break;
    }
  }
}
