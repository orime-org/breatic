// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeArgs } from "@ingest/probe-command.js";
import * as readerOwner from "../served-object-read.js";

let dir: string;
let bigMp4: string;
let opusWebm: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "served-object-read-"));
  bigMp4 = join(dir, "big.mp4");
  // Lossless noise makes a file of tens of MB whose moov box FFmpeg's MP4 muxer writes after the media data.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=4,noise=alls=40:allf=t",
    "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", bigMp4]);
  opusWebm = join(dir, "opus.webm");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=3", "-c:a", "libopus", opusWebm]);
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The reader, read at call time so its absence fails each case on its own.
 * @returns It.
 */
function reader(): typeof readerOwner.readServedObject {
  const value: unknown = Reflect.get(readerOwner, "readServedObject");
  expect(value, "readServedObject is exported").toBeTypeOf("function");
  return value as typeof readerOwner.readServedObject;
}

/**
 * Serve one file as the Worker does, optionally closing the first answer's connection after `dropAt` body bytes while
 * declaring the full length.
 * @param path - The file.
 * @param options - How it is served.
 * @param options.ranges - Whether the server offers byte ranges.
 * @param options.dropAt - Where the first answer's body stops, or null for no drop.
 * @param options.misplacedRanges - Whether a Range request is answered from byte 0, as a server that ignores the asked
 * start would, while saying so in its Content-Range.
 * @returns The server and the file's URL.
 */
async function serve(path: string, options: { ranges: boolean; dropAt: number | null; misplacedRanges?: boolean }): Promise<{ server: Server; url: string }> {
  const bytes = readFileSync(path);
  let dropping = options.dropAt !== null;
  const server = createServer((request, response) => {
    const range = options.ranges ? /^bytes=(\d+)-/.exec(request.headers.range ?? "") : null;
    const from = range === null || options.misplacedRanges === true ? 0 : Number(range[1]);
    const headers: Record<string, string | number> = { "content-length": bytes.length - from };
    if (options.ranges) headers["accept-ranges"] = "bytes";
    if (range !== null) headers["content-range"] = `bytes ${from}-${bytes.length - 1}/${bytes.length}`;
    response.writeHead(range === null ? 200 : 206, headers);
    if (dropping) {
      dropping = false;
      response.write(bytes.subarray(from, options.dropAt!), () => request.socket.destroy());
      return;
    }
    response.end(bytes.subarray(from));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/studio/source%20file.${path.split(".").pop()!}` };
}

/**
 * Stop a test server.
 * @param server - It.
 * @returns Nothing once it is closed.
 */
async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Run FFprobe and keep its exit code instead of throwing on it.
 * @param args - Its arguments.
 * @returns Its exit code and stdout.
 */
function ffprobe(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("ffprobe", args, { maxBuffer: 64 << 20 }, (error, stdout) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout });
    });
  });
}

describe("reading a served object through the loopback reader", () => {
  it("serves FFprobe's seeks as ranges, so a moov-at-end MP4 is not read whole", async () => {
    const size = readFileSync(bigMp4).length;
    const { server, url } = await serve(bigMp4, { ranges: true, dropAt: null });
    try {
      let opened = "";
      const read = await reader()(url, AbortSignal.timeout(60_000), (local) => { opened = local; return ffprobe(probeArgs(local)); });
      expect(read.value.code).toBe(0);
      // The path, and with it the extension FFmpeg's format probe weighs, is the served object's own.
      expect(new URL(opened).pathname).toBe(new URL(url).pathname);
      expect(read.value.stdout).toBe(execFileSync("ffprobe", probeArgs(bigMp4, "own-file")).toString("utf8"));
      expect(read.servedBytes).toBeLessThan(size / 4);
    } finally {
      await stop(server);
    }
  }, 120_000);

  it("fails the read when an upstream drop cannot be resumed, though FFprobe exits 0", async () => {
    const size = readFileSync(opusWebm).length;
    const { server, url } = await serve(opusWebm, { ranges: false, dropAt: Math.floor(size * 0.6) });
    let exit: number | undefined;
    try {
      await expect(reader()(url, AbortSignal.timeout(60_000), async (local) => {
        const ran = await ffprobe(["-v", "error", "-protocol_whitelist", "http,tcp", "-show_entries", "frame=pts,nb_samples", "-of", "compact=p=0", local]);
        exit = ran.code;
        return ran.stdout;
      })).rejects.toThrow(/The stream read failed: the source stopped at \d+ of \d+ bytes/);
      expect(exit, "FFprobe exited 0 with the part it read").toBe(0);
    } finally {
      await stop(server);
    }
  }, 60_000);

  it("fails the read when a resumed answer is not the rest of the object", async () => {
    const size = readFileSync(opusWebm).length;
    const { server, url } = await serve(opusWebm, { ranges: true, dropAt: Math.floor(size * 0.6), misplacedRanges: true });
    try {
      await expect(reader()(url, AbortSignal.timeout(60_000), (local) => ffprobe(["-v", "error", "-protocol_whitelist", "http,tcp",
        "-show_entries", "frame=pts,nb_samples", "-of", "compact=p=0", local]))).rejects.toThrow(/The stream read failed: the source at byte \d+ was answered 206/);
    } finally {
      await stop(server);
    }
  }, 60_000);
});

