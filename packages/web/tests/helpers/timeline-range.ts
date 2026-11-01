// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

/** An inclusive byte interval requested by the native media loader. */
interface ByteRange { start: number; end: number }

/** Safe HTTP evidence: no cookies, authorization headers or arbitrary media URLs. */
interface RangeRequestReading {
  method: string;
  path: string;
  range: string | null;
  status: number;
  contentRange: string | null;
  contentLength: number;
  bodyBytesFlushed: number;
  prefixBytesFlushed: number;
  held: boolean;
  finished: boolean;
  closed: boolean;
}

/** One case's in-process HTTP fixture; no child process or persistent listener. */
export interface TimelineRange {
  url: string;
  fixturePath: string;
  sizeBytes: number;
  holdStart: number;
  rangeRequests: number;
  heldResponses: number;
  prefixBytesFlushed: number;
  bodyBytesFlushed: number;
  requests: RangeRequestReading[];
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
 * driving.mp4 has moov [7801,13020) and mdat [1007817,2565636).
 * The audio packet [1722450,1722794) has PTS 3.2 seconds; hold begins after it.
 * Chromium exposes complete 32KiB media blocks (or EOF), so this prefix supplies
 * real decodable media rather than withholding the tiny sample's entire first block.
 * Metadata is never inside the hold. No fixture bytes are rewritten or synthesized.
 * These offsets describe this fixed fixture, rather than a production buffer policy.
 * @throws {Error} When the fixture changes, cannot be read, or the listener fails.
 */
export async function startTimelineRange(): Promise<TimelineRange> {
  const fixturePath = resolve(__dirname, '../fixtures/mini-tools/driving.mp4');
  const bytes = readFileSync(fixturePath);
  const holdStart = 1722794;
  const holdEnd = 2565636;
  if (bytes.length !== holdEnd || bytes.toString('ascii', 7805, 7809) !== 'moov'
    || bytes.readUInt32BE(7801) !== 5219 || bytes.toString('ascii', 1007821, 1007825) !== 'mdat') {
    throw new Error('driving.mp4 changed; inspect its packets before updating the controlled byte hold');
  }
  let released = false;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((accept) => { releaseGate = accept; });
  const fixture: TimelineRange = {
    url: '', fixturePath, sizeBytes: bytes.length, holdStart, rangeRequests: 0,
    heldResponses: 0, prefixBytesFlushed: 0, bodyBytesFlushed: 0, requests: [], errors: [],
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
   * Await the real socket write callback and count only flushed file bytes.
   * @throws {Error} When Node cannot flush the response bytes.
   */
  async function flushBytes(response: ServerResponse, start: number, end: number, reading: RangeRequestReading): Promise<void> {
    if (response.destroyed || end <= start) return;
    const prefix = !released;
    await new Promise<void>((accept, reject) => response.write(bytes.subarray(start, end), (error) => {
      if (error) reject(error); else accept();
    }));
    reading.bodyBytesFlushed += end - start;
    fixture.bodyBytesFlushed += end - start;
    if (prefix) {
      reading.prefixBytesFlushed += end - start;
      fixture.prefixBytesFlushed += end - start;
    }
  }

  /**
   * Write the available prefix of an interval and resume its remaining bytes on release.
   * @throws {Error} When Node cannot flush the response bytes; the caller records the failure.
   */
  async function writeRange(response: ServerResponse, range: ByteRange, reading: RangeRequestReading): Promise<void> {
    const blocked = !released && range.start < holdEnd && range.end >= holdStart;
    if (blocked) {
      if (range.start < holdStart) await flushBytes(response, range.start, holdStart, reading);
      fixture.heldResponses += 1;
      reading.held = true;
      await gate;
      await flushBytes(response, Math.max(range.start, holdStart), range.end + 1, reading);
    } else if (!response.destroyed) {
      await flushBytes(response, range.start, range.end + 1, reading);
    }
  }

  const server = createServer((request, response) => {
    const reading: RangeRequestReading = {
      method: request.method ?? '', path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      range: request.headers.range ?? null, status: 0, contentRange: null, contentLength: 0,
      bodyBytesFlushed: 0, prefixBytesFlushed: 0, held: false, finished: false, closed: false,
    };
    fixture.requests.push(reading);
    response.on('error', (error) => fixture.errors.push(error.message));
    response.on('finish', () => { reading.finished = true; });
    response.on('close', () => { reading.closed = true; });
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'video/mp4');
    if (request.url !== '/driving.mp4' || !['GET', 'HEAD'].includes(request.method ?? '')) {
      reading.status = 404;
      response.writeHead(404).end();
      return;
    }
    const header = request.headers.range;
    const ranges = header === undefined ? [{ start: 0, end: bytes.length - 1 }] : parseRanges(header, bytes.length);
    if (ranges === null) {
      reading.status = 416;
      reading.contentRange = `bytes */${bytes.length}`;
      response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0 }).end();
      return;
    }
    if (header !== undefined) fixture.rangeRequests += 1;
    const boundary = 'timeline-fixture-range';
    const prefixes = ranges.map((range) => Buffer.from(`--${boundary}\r\nContent-Type: video/mp4\r\nContent-Range: bytes ${range.start}-${range.end}/${bytes.length}\r\n\r\n`));
    const ending = Buffer.from(`--${boundary}--\r\n`);
    if (ranges.length === 1) {
      const [range] = ranges;
      reading.contentLength = range.end - range.start + 1;
      response.setHeader('Content-Length', reading.contentLength);
      if (header !== undefined) {
        reading.contentRange = `bytes ${range.start}-${range.end}/${bytes.length}`;
        response.setHeader('Content-Range', reading.contentRange);
      }
    } else {
      response.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`);
      reading.contentLength = ranges.reduce((sum, range, index) => sum + prefixes[index].length + range.end - range.start + 1 + 2, ending.length);
      response.setHeader('Content-Length', reading.contentLength);
    }
    reading.status = header === undefined ? 200 : 206;
    response.writeHead(reading.status);
    response.flushHeaders();
    if (request.method === 'HEAD') { response.end(); return; }
    void (async () => {
      for (const [index, range] of ranges.entries()) {
        if (response.destroyed) return;
        if (ranges.length > 1) response.write(prefixes[index]);
        await writeRange(response, range, reading);
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
  fixture.url = `http://127.0.0.1:${address.port}/driving.mp4`;
  return fixture;
}
