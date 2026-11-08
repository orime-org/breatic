// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation runner when Chromium goes away during the package check (inner#1711 design §6).
 *
 * A closed DevTools socket or a crashed page is a definite failure: every command still waiting and the wait for the
 * page to load end at once, and the run reports `validation_failed` instead of waiting for the job's deadline.
 *
 * `dsh` and Chromium are shell scripts: the harness exits 0 without writing, and the "browser" prints a DevTools
 * endpoint served by a minimal WebSocket server in this test, which either drops the connection or reports the page
 * crashed. What is under test is the runner's CDP wiring, not either program.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWebAnimation, type WebAnimationRunnerSettings } from "../web-animation-run.js";

/** How long the run may take to report before the test calls it hung; well past anything the run does on its own. */
const REPORT_WITHIN_MS = 5_000;

/** How the fake browser behaves once the runner talks to it. */
type Mode = "socket_closes" | "page_crashes";

let dir: string;
let cdpServer: Server | undefined;
const cdpSockets = new Set<Socket>();
const posts: { url: string; body: unknown }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "web-animation-run-test-"));
  posts.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" && init.method === "POST" ? (JSON.parse(init.body) as unknown) : null;
    posts.push({ url: String(input), body });
    return new Response(null, { status: 200 });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const pid = Number(await readFile(join(dir, "chromium.pid"), "utf8").catch(() => ""));
  if (pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped by the runner.
    }
  }
  for (const socket of cdpSockets) socket.destroy();
  cdpSockets.clear();
  await new Promise((resolve) => (cdpServer === undefined ? resolve(undefined) : cdpServer.close(() => resolve(undefined))));
  cdpServer = undefined;
  await rm(dir, { recursive: true, force: true });
});

/**
 * Write one text frame from the server (unmasked).
 * @param socket - The connection.
 * @param message - The JSON to send.
 */
function sendFrame(socket: Socket, message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

/**
 * Take the complete client frames (masked) off the front of a buffer.
 * @param buffer - What arrived so far.
 * @returns The decoded text payloads, whether a close frame came, and what is left over.
 */
function takeFrames(buffer: Buffer): { messages: string[]; closing: boolean; rest: Buffer } {
  const messages: string[] = [];
  let closing = false;
  let at = 0;
  while (buffer.length - at >= 6) {
    let length = buffer[at + 1]! & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    if (buffer.length < offset + 4 + length) break;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
    const opcode = buffer[at]! & 0x0f;
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
    if (opcode === 0x8) closing = true;
    at = offset + 4 + length;
  }
  return { messages, closing, rest: buffer.subarray(at) };
}

/**
 * Serve a DevTools endpoint that answers every command, and then fails the way the mode says.
 * @param mode - How it fails.
 * @returns The endpoint's `ws://` address.
 */
async function serveFakeCdp(mode: Mode): Promise<string> {
  const server = createServer();
  server.on("upgrade", (req, socket: Socket) => {
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    cdpSockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      const taken = takeFrames(Buffer.concat([buffer, chunk]));
      buffer = taken.rest;
      if (taken.closing) {
        // Answer the client's close as a browser does.
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      for (const text of taken.messages) {
        const command = JSON.parse(text) as { id: number; method: string; sessionId?: string };
        if (mode === "socket_closes" && command.method === "Target.createTarget") {
          // The browser process died: the connection drops with the command unanswered.
          socket.destroy();
          return;
        }
        const result = command.method === "Target.createTarget" ? { targetId: "target-1" }
          : command.method === "Target.attachToTarget" ? { sessionId: "session-1" }
          : {};
        sendFrame(socket, { id: command.id, result, ...(command.sessionId !== undefined && { sessionId: command.sessionId }) });
        if (mode === "page_crashes" && command.method === "Page.navigate") {
          // The renderer crashed while loading: no load event will ever come, and the socket stays open.
          sendFrame(socket, { method: "Inspector.targetCrashed", params: {}, sessionId: "session-1" });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cdpServer = server;
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/fake`;
}

/**
 * Lay out a runner image in the test's directory: a harness that exits 0, a browser that prints the endpoint, an
 * empty runtime and an empty font set.
 * @param endpoint - The DevTools endpoint the browser prints.
 * @returns The settings.
 */
async function image(endpoint: string): Promise<WebAnimationRunnerSettings> {
  const dshBin = join(dir, "dsh");
  await writeFile(dshBin, "#!/bin/sh\nexit 0\n");
  const chromiumBin = join(dir, "chromium");
  await writeFile(chromiumBin, `#!/bin/sh\necho $$ > "${join(dir, "chromium.pid")}"\necho "DevTools listening on ${endpoint}" >&2\nexec sleep 3600\n`);
  await chmod(dshBin, 0o755);
  await chmod(chromiumBin, 0o755);
  const fontsDir = join(dir, "fonts");
  await mkdir(join(fontsDir, "v1"), { recursive: true });
  await writeFile(join(fontsDir, "v1", "faces.json"), "[]");
  const runtimeFile = join(dir, "runtime.js");
  await writeFile(runtimeFile, "");
  const home = join(dir, "home");
  await mkdir(home);
  return { fontsDir, runtimeFile, dshBin, dshProfile: "test", chromiumBin, home };
}

/**
 * Run once and wait for it to report, failing the test when it does not report in time.
 * @param settings - The image.
 * @returns What it reported.
 */
async function runAndReport(settings: WebAnimationRunnerSettings): Promise<unknown> {
  const run = runWebAnimation({
    prompt: "A red square slides in",
    viewport: { width: 640, height: 360 },
    fps: { num: 24, den: 1 },
    durationFrames: 48,
    fontSetVersion: 1,
    maxPackageBytes: 10_000_000,
    packageUrl: "http://r2.local/index.html",
    manifestUrl: "http://r2.local/manifest.json",
    progressUrl: "http://jobs.local/progress",
    reportUrl: "http://jobs.local/report",
  }, settings);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the run did not report within ${REPORT_WITHIN_MS} ms of Chromium going away`)), REPORT_WITHIN_MS);
  });
  try {
    await Promise.race([run, hung]);
  } finally {
    clearTimeout(timer);
  }
  return posts.find((post) => post.url === "http://jobs.local/report")?.body;
}

describe("Chromium going away during the package check", () => {
  it("fails the run as validation_failed at once when the DevTools socket closes", { timeout: REPORT_WITHIN_MS + 5_000 }, async () => {
    const settings = await image(await serveFakeCdp("socket_closes"));
    expect(await runAndReport(settings)).toEqual({ ok: false, failureReason: "validation_failed", cpuUsec: expect.toSatisfy((v: unknown) => v === null || typeof v === "number") });
    expect(posts.map((post) => post.url)).not.toContain("http://r2.local/index.html");
  });

  it("fails the run as validation_failed at once when the page crashes before it loads", { timeout: REPORT_WITHIN_MS + 5_000 }, async () => {
    const settings = await image(await serveFakeCdp("page_crashes"));
    expect(await runAndReport(settings)).toEqual({ ok: false, failureReason: "validation_failed", cpuUsec: expect.toSatisfy((v: unknown) => v === null || typeof v === "number") });
    expect(posts.map((post) => post.url)).not.toContain("http://r2.local/index.html");
  });
});
