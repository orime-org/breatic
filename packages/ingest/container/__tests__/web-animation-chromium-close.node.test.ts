// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Closing the check's Chromium before its profile is removed (inner#1711).
 *
 * Chromium's own child processes keep writing into the user-data directory after the browser process is killed, so a
 * kill followed at once by a recursive remove fails with ENOTEMPTY and turned a passed check into `validation_failed`.
 * The browser leads its own process group; closing kills the whole group, waits for the browser to exit, then removes
 * the profile with retries. A cleanup failure is logged and never changes the check's verdict.
 *
 * The "browser" here is a real detached node process whose child keeps creating files in `profile/Default`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHROMIUM_SPAWN_OPTIONS, closeChromium } from "../web-animation-run.js";

/** Keeps creating files in the directory given as its argument, every millisecond. */
const WRITER = `const fs = require("fs"), path = require("path"); const dir = process.argv[1]; let i = 0;
setInterval(() => { for (let k = 0; k < 20; k++) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "f" + i++), "x"); } catch {} } }, 1);`;

/** Starts WRITER as its own child (same process group), records that child's pid, then idles. */
const BROWSER = `const { spawn } = require("child_process");
const writer = spawn(process.execPath, ["-e", ${JSON.stringify(WRITER)}, process.argv[1]], { stdio: "ignore" });
require("fs").writeFileSync(process.argv[2], String(writer.pid)); setInterval(() => {}, 1000);`;

let dir: string;
let browser: ChildProcess | undefined;
let writerPid = 0;
let locked: string | undefined;

/**
 * Whether a process still exists.
 * @param pid - The process.
 * @returns False once it is gone.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until a condition holds or the time runs out.
 * @param condition - What to wait for.
 * @param withinMs - How long to wait.
 * @returns Whether it held.
 */
async function until(condition: () => boolean | Promise<boolean>, withinMs: number): Promise<boolean> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chromium-close-test-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A pid of 0 would signal the test runner's own process group, so only real pids are signalled.
  const browserPid = browser?.pid ?? 0;
  for (const kill of [() => browserPid > 0 && process.kill(-browserPid, "SIGKILL"), () => browser?.kill("SIGKILL"), () => writerPid > 0 && process.kill(writerPid, "SIGKILL")]) {
    try {
      kill();
    } catch {
      // Already stopped.
    }
  }
  browser = undefined;
  writerPid = 0;
  if (locked !== undefined) await chmod(locked, 0o700);
  locked = undefined;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await rm(dir, { recursive: true, force: true });
});

describe("closeChromium", () => {
  it("kills Chromium's whole process tree and then removes the profile it was writing to", async () => {
    const profile = join(dir, "profile");
    const pidFile = join(dir, "writer.pid");
    await mkdir(join(profile, "Default"), { recursive: true });
    browser = spawn(process.execPath, ["-e", BROWSER, join(profile, "Default"), pidFile], { detached: true, stdio: "ignore" });
    expect(await until(async () => (writerPid = Number(await readFile(pidFile, "utf8").catch(() => ""))) > 0, 3_000)).toBe(true);
    expect(await until(async () => (await readdir(join(profile, "Default"))).length > 0, 3_000)).toBe(true);

    await closeChromium(browser, profile);

    expect(browser.exitCode !== null || browser.signalCode !== null).toBe(true);
    await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await until(() => !alive(writerPid), 1_000)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs a profile it cannot remove after Chromium has exited, without rejecting", async () => {
    locked = join(dir, "locked");
    const profile = join(locked, "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "Local State"), "{}");
    await chmod(locked, 0o500);
    browser = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const child = browser;
    const exitedWhenLogged: boolean[] = [];
    vi.mocked(console.error).mockImplementation(() => {
      exitedWhenLogged.push(child.exitCode !== null || child.signalCode !== null);
    });

    await expect(closeChromium(child, profile)).resolves.toBeUndefined();

    expect(exitedWhenLogged.length).toBeGreaterThan(0);
    expect(exitedWhenLogged.every(Boolean)).toBe(true);
  });
});

describe("CHROMIUM_SPAWN_OPTIONS", () => {
  it("starts Chromium as the leader of its own process group", () => {
    expect(CHROMIUM_SPAWN_OPTIONS).toMatchObject({ detached: true });
  });
});
