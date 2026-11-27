// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The long-media seek probe reads only around its seek over HTTP (inner#1306, ING-R2-1): a fragmented MP4 without its
 * trailing mfra index makes the mov demuxer walk every top-level moof on open, which over HTTP reads the whole file. With
 * `-use_mfra_for pts` it seeks through the index instead.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seekLandingArgs } from '@ingest/probe-command.js';

const run = promisify(execFile);
let server: Server;
let url = '';
let file: Buffer;
let sent = 0;

beforeAll(async () => {
  // One fragment per all-intra frame, as a fragmented upload or edit file has.
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10,noise=alls=60:allf=t',
    '-c:v', 'libx264', '-g', '1', '-crf', '8', '-pix_fmt', 'yuv420p', '-movflags', '+frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  file = stdout;
  server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null || range[2] === '' ? file.byteLength - 1 : Number(range[2]);
    const part = file.subarray(start, end + 1);
    response.writeHead(range === null ? 200 : 206, {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(part.byteLength),
      ...(range === null ? {} : { 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(file.byteLength)}` }),
    });
    // Count what leaves the server, so an abandoned read counts only what was written before it was dropped.
    for (let at = 0; at < part.byteLength; at += 65_536) {
      const piece = part.subarray(at, at + 65_536);
      if (!response.write(piece)) { sent += piece.byteLength; break; }
      sent += piece.byteLength;
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/upload.mp4`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the long-media seek probe on a fragmented MP4', () => {
  it('SL01 lands on the packet at 9 s while reading under half the file', async () => {
    sent = 0;
    const { stdout } = await run('ffprobe', seekLandingArgs(url, 9_000_000n));
    const [pts] = stdout.trim().split('\n')[0]!.split(',');
    expect(Math.abs(Number(pts) - 9)).toBeLessThan(0.05);
    expect(sent, `read ${String(sent)} of ${String(file.byteLength)} bytes`).toBeLessThan(file.byteLength / 2);
  }, 120_000);
});
