// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

/** An inclusive byte interval requested by the native media loader. */
interface ByteRange { start: number; end: number }

/** One case's in-process HTTP fixture; no child process or persistent listener. */
export interface TimelineRange {
  url: string;
  sizeBytes: number;
  rangeRequests: number;
  heldResponses: number;
  errors: string[];
  release: () => void;
  close: () => Promise<void>;
}

/**
 * Parse open, closed, suffix and multipart byte ranges without changing their meaning.
 * @throws {never} Never.
 */
function parseRanges(header: string, size: number): ByteRange[] | null {
  if (!header.startsWith('bytes=')) return null;
  const ranges: ByteRange[] = [];
  for (const value of header.slice(6).split(',')) {
    const match = /^(\d*)-(\d*)$/.exec(value.trim());
    if (match === null || (match[1] === '' && match[2] === '')) return null;
    const suffix = match[1] === '';
    const first = Number(suffix ? match[2] : match[1]);
    const last = match[2] === '' || suffix ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < 0) return null;
    if (suffix && first === 0) continue;
    const start = suffix ? Math.max(0, size - first) : first;
    const end = Math.min(last, size - 1);
    if (start < size && start <= end) ranges.push({ start, end });
  }
  return ranges.length === 0 ? null : ranges;
}

/**
 * Serve the unchanged MP4 while holding its later media bytes until explicit release.
 *
 * The checked-in fixture has ftyp [0,32), moov [32,4166), free [4166,4174),
 * and mdat [4174,6474). The packet beginning at 5585 has video PTS 7.2;
 * preceding audio reaches 6.144 seconds. Metadata is never inside the hold.
 * These offsets describe this fixed fixture, rather than a production buffer policy.
 * @throws {Error} When the fixture changes, cannot be read, or the listener fails.
 */
export async function startTimelineRange(): Promise<TimelineRange> {
  const bytes = readFileSync(resolve(__dirname, '../fixtures/media-history.mp4'));
  const holdStart = 5585;
  const holdEnd = 6474;
  if (bytes.length !== holdEnd || bytes.toString('ascii', 36, 40) !== 'moov'
    || bytes.readUInt32BE(32) !== 4134 || bytes.toString('ascii', 4178, 4182) !== 'mdat') {
    throw new Error('media-history.mp4 changed; inspect its packets before updating the controlled byte hold');
  }
  let released = false;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((accept) => { releaseGate = accept; });
  const fixture: TimelineRange = {
    url: '', sizeBytes: bytes.length, rangeRequests: 0, heldResponses: 0, errors: [],
    release: (): void => { released = true; releaseGate(); },
    close: async (): Promise<void> => {
      fixture.release();
      await new Promise<void>((accept, reject) => {
        server.close((error) => { if (error) reject(error); else accept(); });
        server.closeAllConnections();
      });
    },
  };

  /**
   * Write the available prefix of an interval and resume its remaining bytes on release.
   * @throws {never} Never; response errors are collected by the caller's error listener.
   */
  async function writeRange(response: ServerResponse, range: ByteRange): Promise<void> {
    const blocked = !released && range.start < holdEnd && range.end >= holdStart;
    if (blocked) {
      if (range.start < holdStart) response.write(bytes.subarray(range.start, holdStart));
      fixture.heldResponses += 1;
      await gate;
      if (!response.destroyed) response.write(bytes.subarray(Math.max(range.start, holdStart), range.end + 1));
    } else if (!response.destroyed) {
      response.write(bytes.subarray(range.start, range.end + 1));
    }
  }

  const server = createServer((request, response) => {
    response.on('error', (error) => fixture.errors.push(error.message));
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'video/mp4');
    if (request.url !== '/media-history.mp4' || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(404).end();
      return;
    }
    const header = request.headers.range;
    const ranges = header === undefined ? [{ start: 0, end: bytes.length - 1 }] : parseRanges(header, bytes.length);
    if (ranges === null) {
      response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0 }).end();
      return;
    }
    if (header !== undefined) fixture.rangeRequests += 1;
    const boundary = 'timeline-fixture-range';
    const prefixes = ranges.map((range) => Buffer.from(`--${boundary}\r\nContent-Type: video/mp4\r\nContent-Range: bytes ${range.start}-${range.end}/${bytes.length}\r\n\r\n`));
    const ending = Buffer.from(`--${boundary}--\r\n`);
    if (ranges.length === 1) {
      const [range] = ranges;
      response.setHeader('Content-Length', range.end - range.start + 1);
      if (header !== undefined) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`);
    } else {
      response.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`);
      response.setHeader('Content-Length', ranges.reduce((sum, range, index) => sum + prefixes[index].length + range.end - range.start + 1 + 2, ending.length));
    }
    response.writeHead(header === undefined ? 200 : 206);
    response.flushHeaders();
    if (request.method === 'HEAD') { response.end(); return; }
    void (async () => {
      for (const [index, range] of ranges.entries()) {
        if (response.destroyed) return;
        if (ranges.length > 1) response.write(prefixes[index]);
        await writeRange(response, range);
        if (response.destroyed) return;
        if (ranges.length > 1) response.write('\r\n');
      }
      if (ranges.length > 1) response.write(ending);
      response.end();
    })().catch((error: unknown) => {
      fixture.errors.push(String(error));
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); accept(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await fixture.close();
    throw new Error('the Timeline range fixture has no loopback TCP address');
  }
  fixture.url = `http://127.0.0.1:${address.port}/media-history.mp4`;
  return fixture;
}
