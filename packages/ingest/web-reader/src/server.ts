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
import { chromium, errors, type Browser, type Download, type Response } from "playwright-core";
import { READER_SERVICE_PORT, READER_UNREACHABLE_HEADER, readPagesRequestSchema } from "@shared/agent/read-pages.js";
import type { ReadPageResult, ReadPagesRequest, ReaderServiceAnswer } from "@shared/agent/read-pages.js";

import { articleOf } from "./article.js";
import { isMediaType, mediaTypeOf, recoverUtf8, textOfDownload } from "./body-text.js";
import { statusOfResponse } from "./classify.js";
import { cpuUsecOf } from "./cpu-usage.js";
import { isPdf, readPdf } from "./pdf-page.js";
import { readAll } from "./read-all.js";
import { capPageText, perPageTextUnits } from "./text-cap.js";
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
  browser ??= chromium.launch({ args: ["--no-sandbox"] }).catch((err: unknown) => {
    browser = undefined;
    throw err;
  });
  return browser;
}

/**
 * A page read as text: ok, or empty when the text is only whitespace.
 * @param url - The page asked for.
 * @param where - Its HTTP status when known, its final address and its title.
 * @param text - The text read from it.
 * @returns The page.
 */
function textPage(
  url: string,
  where: { httpStatus?: number; finalUrl: string; title?: string },
  text: string,
): ReadPageResult {
  if (text.trim() === "") return { url, status: "empty", ...where, kind: "html" };
  return { url, status: "ok", ...where, kind: "html", text };
}

/**
 * Read a page that arrived as a download: a PDF, a text file, or a file of
 * another type, which is not read.
 *
 * The navigation's headers are judged before the file is waited for, so an
 * oversized file or a media file (`isMediaType`) is cancelled rather than
 * downloaded. Any other file is fetched: one that starts `%PDF-` is read as
 * a PDF whatever its type, and otherwise as text when its type is text.
 * @param url - The page asked for.
 * @param download - The download.
 * @param head - The navigation's response, when one arrived.
 * @param maxBytes - The largest file read.
 * @returns The page.
 */
async function readDownload(
  url: string,
  download: Download,
  head: Response | undefined,
  maxBytes: number,
): Promise<ReadPageResult> {
  const finalUrl = download.url();
  const headers = head?.headers() ?? {};
  const length = Number(headers["content-length"]);
  if (Number.isFinite(length) && length > maxBytes) {
    await download.cancel().catch(() => undefined);
    return { url, status: "too_large", finalUrl };
  }
  if (isMediaType(mediaTypeOf(headers["content-type"] ?? ""))) {
    await download.cancel().catch(() => undefined);
    return { url, status: "unsupported_type", finalUrl };
  }
  const path = await download.path();
  if (statSync(path).size > maxBytes) return { url, status: "too_large", finalUrl };
  const bytes = new Uint8Array(readFileSync(path));
  if (isPdf(bytes)) return readPdf(url, finalUrl, bytes);
  const text = textOfDownload(bytes, headers["content-type"] ?? null);
  if (text === null) return { url, status: "unsupported_type", finalUrl };
  return textPage(url, { ...(head !== undefined && { httpStatus: head.status() }), finalUrl }, text);
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
    // A page's CSP would otherwise refuse the Readability script.
    bypassCSP: true,
  });
  const stop = (): void => {
    void context.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const page = await context.newPage();
    const downloaded = page.waitForEvent("download", { timeout: request.pageTimeoutMs }).catch(() => null);
    // A navigation that turns into a download has no response from goto; its
    // headers come from here.
    let head: Response | undefined;
    page.on("response", (answer) => {
      if (answer.request().isNavigationRequest() && answer.frame() === page.mainFrame()) head = answer;
    });
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: request.pageTimeoutMs });
    } catch (err) {
      // A PDF navigates into a download, which the headless shell has no viewer for.
      if (err instanceof Error && /Download is starting/.test(err.message)) {
        const download = await downloaded;
        if (download !== null) return await readDownload(url, download, head, request.maxBytes);
      }
      if (err instanceof errors.TimeoutError) return { url, status: "too_slow" };
      throw err;
    }
    if (response === null) return { url, status: "unreachable" };
    const httpStatus = response.status();
    const headers = response.headers();
    const ended = statusOfResponse(httpStatus, headers["content-type"] ?? null, headers[READER_UNREACHABLE_HEADER] === "1");
    if (ended !== null) return { url, status: ended, httpStatus, finalUrl: page.url() };

    await page.waitForLoadState("networkidle", { timeout: request.settleMs }).catch(() => undefined);
    // A document that is not HTML is judged again by the type the browser
    // saw (an image sent with no type is still an image), and a text one is
    // read as the body the site sent: what the browser renders of it is not
    // the file. Chromium hands a text body over already decoded in the charset
    // its content-type names, or as windows-1252 when it names none, which
    // `recoverUtf8` undoes for UTF-8. Readability goes only into HTML.
    const [contentType, characterSet, documentTitle] = await page.evaluate(() => [
      document.contentType,
      document.characterSet,
      document.title,
    ]);
    if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
      const seen = statusOfResponse(httpStatus, contentType);
      if (seen !== null) return { url, status: seen, httpStatus, finalUrl: page.url() };
      const text = recoverUtf8(await response.text(), headers["content-type"] ?? null, characterSet);
      return textPage(url, { httpStatus, finalUrl: page.url(), title: documentTitle }, text);
    }
    await page.addScriptTag({ content: READABILITY }).catch(() => undefined);
    const evaluated: unknown = await page.evaluate(() => {
      type Parsed = { title?: string | null; content?: string | null } | null;
      const Readability = (globalThis as unknown as { Readability?: new (doc: Document) => { parse(): Parsed } })
        .Readability;
      // No Readability (the script could not run) or no body: the text as it stands.
      if (typeof Readability !== "function" || document.body === null) {
        return { title: document.title, html: "", text: document.documentElement?.textContent ?? "" };
      }
      let parsed: Parsed = null;
      try {
        parsed = new Readability(document.cloneNode(true) as Document).parse();
      } catch {
        parsed = null;
      }
      return { title: parsed?.title ?? document.title, html: parsed?.content ?? document.body.innerHTML };
    });
    const article = articleOf(evaluated);
    const plain = (evaluated as { text?: unknown } | null)?.text;
    const text = typeof plain === "string" ? plain : toMarkdown(article.html);
    return textPage(url, { httpStatus, finalUrl: page.url(), title: article.title }, text);
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
  // Started before any page, so a browser that will not launch fails the call
  // (500) rather than reading as every page being unreachable.
  await theBrowser();
  const pages = await readAll(request.urls, {
    concurrency: request.concurrency,
    deadlineAt: request.deadlineAt,
    pageTimeoutMs: request.pageTimeoutMs,
    readOne: (url, signal) => readOne(url, signal, request),
  });
  const cap = perPageTextUnits(request.urls.length);
  const answer: ReaderServiceAnswer = { pages: pages.map((page) => capPageText(page, cap)), cpuUsec: cpuUsec() };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error("web_reader_request_failed", err);
    if (!res.headersSent) res.writeHead(500).end(err instanceof Error ? err.message : String(err));
  });
}).listen(READER_SERVICE_PORT);
