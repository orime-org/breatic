// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page reader service (inner#1664): one Chromium headless shell reading a
 * call's pages a few at a time, inside a container started for that call.
 *
 * `POST /read` takes a `ReadPagesRequest` and answers `{ pages, cpuUsec }`.
 * Every request the browser makes leaves through the Worker's outbound
 * handler, which refuses addresses that name a machine and sends the rest
 * again from the Worker; HTTPS reaches that handler through Cloudflare's
 * interception, whose certificate the browser is told to accept, and the TLS
 * to the real site is the Worker's own.
 */
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { chromium, errors, type Browser, type Download } from "playwright-core";
import { READER_SERVICE_PORT, readPagesRequestSchema } from "@shared/agent/read-pages.js";
import type { ReadPageResult, ReadPagesRequest, ReaderServiceAnswer } from "@shared/agent/read-pages.js";

import { statusOfResponse } from "./classify.js";
import { cpuUsecOf } from "./cpu-usage.js";
import { pdfText } from "./pdf-text.js";
import { readAll } from "./read-all.js";
import { toMarkdown } from "./to-markdown.js";

/** Who reads, said plainly, in the form ChatGPT-User and Claude-User use. */
const USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Breatic-User/1.0; +https://breatic.ai";

/** Readability's source, run inside each rendered page. */
const READABILITY = readFileSync(createRequire(import.meta.url).resolve("@mozilla/readability/Readability.js"), "utf8");

/** Where the container's cgroup reports its CPU time. */
const CPU_STAT = "/sys/fs/cgroup/cpu.stat";

let browser: Promise<Browser> | undefined;

/**
 * The one browser this container runs, started on first use.
 * @returns The browser.
 */
function theBrowser(): Promise<Browser> {
  browser ??= chromium.launch({ args: ["--no-sandbox"] });
  return browser;
}

/**
 * Read a page that arrived as a download: a PDF, or a file of another type.
 * @param url - The page asked for.
 * @param download - The download.
 * @param maxBytes - The largest file read.
 * @returns The page.
 */
async function readDownload(url: string, download: Download, maxBytes: number): Promise<ReadPageResult> {
  const path = await download.path();
  if (statSync(path).size > maxBytes) return { url, status: "too_large", finalUrl: download.url() };
  const bytes = new Uint8Array(readFileSync(path));
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    return { url, status: "unsupported_type", finalUrl: download.url() };
  }
  const { text, pages } = await pdfText(bytes);
  if (text.trim() === "") return { url, status: "empty", finalUrl: download.url(), kind: "pdf", pages };
  return { url, status: "ok", finalUrl: download.url(), kind: "pdf", pages, text };
}

/**
 * Read one page.
 * @param url - The page.
 * @param signal - Fires when the call's reading must stop.
 * @param request - The call's limits.
 * @returns The page.
 * @throws {Error} When the page could not be reached at all.
 */
async function readOne(url: string, signal: AbortSignal, request: ReadPagesRequest): Promise<ReadPageResult> {
  const context = await (await theBrowser()).newContext({
    userAgent: USER_AGENT,
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
  });
  const stop = (): void => {
    void context.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const page = await context.newPage();
    const downloaded = page.waitForEvent("download", { timeout: request.pageTimeoutMs }).catch(() => null);
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: request.pageTimeoutMs });
    } catch (err) {
      // A PDF navigates into a download, which the headless shell has no viewer for.
      if (err instanceof Error && /Download is starting/.test(err.message)) {
        const download = await downloaded;
        if (download !== null) return await readDownload(url, download, request.maxBytes);
      }
      if (err instanceof errors.TimeoutError) return { url, status: "too_slow" };
      throw err;
    }
    if (response === null) return { url, status: "unreachable" };
    const httpStatus = response.status();
    const ended = statusOfResponse(httpStatus, response.headers()["content-type"] ?? null);
    if (ended !== null) return { url, status: ended, httpStatus, finalUrl: page.url() };

    await page.waitForLoadState("networkidle", { timeout: request.settleMs }).catch(() => undefined);
    await page.addScriptTag({ content: READABILITY });
    const article = await page.evaluate(() => {
      const parsed = new (globalThis as unknown as { Readability: new (doc: Document) => { parse(): { title?: string | null; content?: string | null } | null } }).Readability(
        document.cloneNode(true) as Document,
      ).parse();
      return { title: parsed?.title ?? document.title, html: parsed?.content ?? document.body.innerHTML };
    });
    const text = toMarkdown(article.html);
    const title = article.title ?? "";
    if (text.trim() === "") return { url, status: "empty", httpStatus, finalUrl: page.url(), title, kind: "html" };
    return { url, status: "ok", httpStatus, finalUrl: page.url(), title, kind: "html", text };
  } catch (err) {
    if (err instanceof errors.TimeoutError) return { url, status: "too_slow" };
    throw err;
  } finally {
    signal.removeEventListener("abort", stop);
    await context.close().catch(() => undefined);
  }
}

/**
 * The CPU time the container has used.
 * @returns Microseconds, or null when the cgroup cannot be read.
 */
function cpuUsec(): number | null {
  try {
    return cpuUsecOf(readFileSync(CPU_STAT, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The body of a request, as text.
 * @param req - The request.
 * @returns Its body.
 */
async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Answer one request to the service.
 * @param req - The request.
 * @param res - The response.
 * @returns Nothing.
 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST" || req.url !== "/read") {
    res.writeHead(404).end();
    return;
  }
  const parsed = readPagesRequestSchema.safeParse(JSON.parse(await bodyOf(req)) as unknown);
  if (!parsed.success) {
    res.writeHead(400).end("Not a read-pages request");
    return;
  }
  const request = parsed.data;
  const pages = await readAll(request.urls, {
    concurrency: request.concurrency,
    deadlineAt: request.deadlineAt,
    readOne: (url, signal) => readOne(url, signal, request),
  });
  const answer: ReaderServiceAnswer = { pages, cpuUsec: cpuUsec() };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error("web_reader_request_failed", err);
    if (!res.headersSent) res.writeHead(500).end();
  });
}).listen(READER_SERVICE_PORT);
