// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One web-animation run inside its container (inner#1711 design §6): write the workspace template and instructions,
 * run the DeepSeek Harness on them, pack what it wrote, check the package in Chromium, PUT the package and its
 * Manifest through `r2.local` and report through `jobs.local`.
 *
 * The container has no internet; every model call the harness makes goes through `model.local`, where the Worker's
 * relay adds the real key and records the call. Chromium is driven over CDP with Node's own WebSocket, so the
 * service loads nothing but Node and our code. No step has a time of its own: the job's deadline ends the container
 * (inner#1367).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { durationToFrames } from "@shared/timeline/time.js";
import { WEB_ANIMATION_BRIDGE_SCRIPT } from "@shared/timeline/web-animation-bridge.js";
import type { WebAnimationRunBody, WebAnimationRunPhase } from "@ingest/jobs/web-animation-run-body.js";

import { cpuUsec } from "./run-steps.js";
import {
  WEB_ANIMATION_FONT_FAMILIES,
  buildFontSetStylesheet,
  buildWebAnimationManifest,
  judgeWebAnimationCheck,
  packWebAnimationSource,
  webAnimationDshEnv,
  type WebAnimationCheckObservation,
  type WebAnimationFontFace,
} from "./web-animation-package.js";

/** Where the image keeps what a run needs, read from its environment once. */
export interface WebAnimationRunnerSettings {
  /** Holds `v<version>/` directories of woff2 files and their `faces.json`. */
  fontsDir: string;
  /** The HyperFrames runtime, `hyperframe.runtime.iife.js`. */
  runtimeFile: string;
  dshBin: string;
  /** The dsh profile the image installs under `$HOME/.dsh/profiles`. */
  dshProfile: string;
  chromiumBin: string;
  /** The harness's home. */
  home: string;
}

/** The loopback port the check page and the font set are served on. */
const CHECK_PORT = 9100;

/** The check page's address. */
const CHECK_PAGE = `http://127.0.0.1:${CHECK_PORT}/web-animation/check/index.html`;

/** What the browser asks the check origin for on its own, not the page: never counted as a page request. */
const BROWSER_OWN = new Set([CHECK_PAGE, `http://127.0.0.1:${CHECK_PORT}/favicon.ico`]);

/** A font file name the check server serves. */
const FONT_FILE = /^[A-Za-z0-9_.-]+\.woff2$/;

/**
 * Seconds the composition declares for a frame count: whole seconds when they convert back exactly, otherwise the
 * microsecond below, which still rounds up to the same frame.
 * @param frames - The frame count.
 * @param fps - The frame rate.
 * @returns The seconds.
 * @throws {RangeError} When the rate is invalid.
 */
function secondsOf(frames: number, fps: WebAnimationRunBody["fps"]): number {
  const exact = (frames * fps.den) / fps.num;
  const whole = Math.round(exact);
  if (whole > 0 && durationToFrames(whole, fps) === frames) return whole;
  return Math.floor(exact * 1e6) / 1e6;
}

/**
 * The starting `index.html` the harness edits.
 * @param job - The run.
 * @returns The template.
 * @throws {RangeError} When the rate is invalid.
 */
function compositionTemplate(job: WebAnimationRunBody): string {
  const { width, height } = job.viewport;
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Web animation</title>",
    "<style>",
    "html, body { margin: 0; background: #000; overflow: hidden; }",
    `#main { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; font-family: "Noto Sans SC", "Noto Sans TC", "Noto Sans JP", "Noto Sans KR"; }`,
    "</style>",
    "</head>",
    "<body>",
    `<div id="main" data-composition-id="main" data-start="0" data-duration="${secondsOf(job.durationFrames, job.fps)}" data-width="${width}" data-height="${height}">`,
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The workspace instructions the harness loads as `AGENTS.md`.
 * @param job - The run.
 * @returns The instructions.
 * @throws {RangeError} When the rate is invalid.
 */
function instructions(job: WebAnimationRunBody): string {
  const seconds = secondsOf(job.durationFrames, job.fps);
  const { width, height } = job.viewport;
  const families = WEB_ANIMATION_FONT_FAMILIES.map((family) => `"${family}"`).join(", ");
  return [
    "# Web animation",
    "",
    "You write one web animation as a HyperFrames composition in `index.html` in this directory. Only that file is kept;",
    "it is packed with the HyperFrames runtime and played on a video timeline, which seeks it to any time.",
    "",
    "## Fixed by the request",
    "",
    `- The root element is \`#main\` with \`data-composition-id="main"\`. Keep \`data-start="0"\`, \`data-duration="${seconds}"\`,`,
    `  \`data-width="${width}"\` and \`data-height="${height}"\` exactly: the animation lasts ${seconds} seconds on a ${width}x${height} pixel stage.`,
    "- Put everything visible inside `#main`.",
    "",
    "## Rules",
    "",
    "- Animate only with CSS animations or the Web Animations API (`element.animate`), timed from 0 to the duration. The",
    "  runtime seeks them; the same time must always draw the same frame, seeking forward or backward. Never drive",
    "  visuals from timers, `requestAnimationFrame`, `Date.now()`, `performance.now()` or `Math.random()`.",
    `- Text uses only the font families ${families}, weights 100 to 900. Do not use any other font or a generic family alone.`,
    "  Japanese text puts \"Noto Sans JP\" first in its `font-family` list, Traditional Chinese text puts \"Noto Sans TC\"",
    "  first and Korean text needs \"Noto Sans KR\"; each carries characters the other families lack.",
    "- Load nothing: no external scripts, stylesheets, fonts, images, `fetch` or network access of any kind. Draw images",
    "  with inline SVG, CSS or `data:` URIs. No audio or video.",
    "- Write visible text in the language of the request.",
    "- Do not run a web server or a browser; when `index.html` is complete, stop.",
    "",
  ].join("\n");
}

/**
 * Send JSON to one of the Worker's hosts.
 * @param url - Where.
 * @param body - What.
 * @returns Nothing; a failed post is logged, because the report path is the only one left.
 */
async function post(url: string, body: unknown): Promise<void> {
  const answered = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err: unknown) => err);
  if (!(answered instanceof Response) || !answered.ok) {
    console.error("web_animation_post_failed", { url, answered: answered instanceof Response ? answered.status : String(answered) });
  }
}

/**
 * PUT one output through `r2.local`.
 * @param url - Where.
 * @param body - The bytes.
 * @returns Nothing.
 * @throws {Error} When the Worker does not take it.
 */
async function put(url: string, body: string): Promise<void> {
  const answered = await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body });
  if (!answered.ok) throw new Error(`the write of ${url} was answered ${answered.status}`);
}

/**
 * Run the harness on the workspace until it exits.
 * @param job - The run.
 * @param work - The workspace.
 * @param settings - Where dsh and its home are.
 * @param onStep - Called for each tool call the harness makes.
 * @returns Its exit code.
 */
function runHarness(
  job: WebAnimationRunBody,
  work: string,
  settings: WebAnimationRunnerSettings,
  onStep: (step: { tool: string; path?: string }) => void,
): Promise<number | null> {
  const task = `Build the web animation described below in index.html, following AGENTS.md.\n\n${job.prompt}`;
  const child = spawn(settings.dshBin, ["--profile", settings.dshProfile, "--json", task], {
    cwd: work,
    env: webAnimationDshEnv({ HOME: settings.home, PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // dsh writes only events to stdout with --json; anything else is not a step.
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const { type, tool, input } = event as { type?: unknown; tool?: unknown; input?: unknown };
    if (type !== "tool_call" || typeof tool !== "string") return;
    const path = typeof input === "object" && input !== null ? (input as { file_path?: unknown; path?: unknown }) : {};
    const file = typeof path.file_path === "string" ? path.file_path : typeof path.path === "string" ? path.path : undefined;
    onStep({ tool, ...(file !== undefined && { path: file }) });
  });
  return new Promise((resolve) => {
    child.on("error", (err) => {
      console.error("web_animation_harness_failed", { err: String(err) });
      resolve(null);
    });
    child.on("close", (code) => {
      if (code !== 0) console.error("web_animation_harness_exit", { code, stderr });
      resolve(code);
    });
  });
}

/**
 * Serve the package and the font set on loopback, as the preview route lays them out.
 * @param html - The package.
 * @param fontsDir - Where the font set's versions are.
 * @returns The listening server.
 */
function serveCheck(html: string, fontsDir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", CHECK_PAGE).pathname;
    if (path === new URL(CHECK_PAGE).pathname) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    const font = /^\/web-animation\/fonts\/(v\d+)\/([^/]+)$/.exec(path);
    if (font === null || !FONT_FILE.test(font[2] ?? "")) {
      res.writeHead(404).end();
      return;
    }
    readFile(join(fontsDir, font[1] ?? "", font[2] ?? "")).then(
      (bytes) => res.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" }).end(bytes),
      () => res.writeHead(404).end(),
    );
  });
  return new Promise((resolve) => server.listen(CHECK_PORT, "127.0.0.1", () => resolve(server)));
}

/** One CDP connection: send a command, and hear events. */
interface Cdp {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
  on: (method: string, listener: (params: Record<string, unknown>) => void) => void;
  /** End the connection: every command still waiting, and {@link Cdp.gone}, reject with the reason. */
  fail: (reason: Error) => void;
  /** Rejects once the connection ends; it never resolves. Race a wait for an event against it. */
  gone: Promise<never>;
  close: () => void;
}

/**
 * Connect to a browser's DevTools endpoint. When the socket closes, every command still waiting rejects at once, as
 * does every command sent afterwards: a browser that went away answers nothing.
 * @param url - The `ws://` endpoint Chromium printed.
 * @returns The connection.
 */
function connectCdp(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  let next = 0;
  let ended: Error | undefined;
  const pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  const listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  let rejectGone: (err: Error) => void = () => {};
  const gone = new Promise<never>((_, reject) => {
    rejectGone = reject;
  });
  // Rejecting before anyone races it is expected, not an unhandled failure.
  gone.catch(() => {});
  /**
   * End the connection with a reason, once.
   * @param reason - Why it ended.
   */
  const fail = (reason: Error): void => {
    if (ended !== undefined) return;
    ended = reason;
    for (const waiting of pending.values()) waiting.reject(reason);
    pending.clear();
    rejectGone(reason);
    socket.close();
  };
  socket.addEventListener("close", () => fail(new Error("the DevTools connection closed")));
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data)) as {
      id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>;
    };
    if (data.id !== undefined) {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.error !== undefined) waiting?.reject(new Error(data.error.message));
      else waiting?.resolve(data.result ?? {});
      return;
    }
    for (const listener of listeners.get(data.method ?? "") ?? []) listener(data.params ?? {});
  });
  const cdp: Cdp = {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      if (ended !== undefined) {
        reject(ended);
        return;
      }
      next += 1;
      pending.set(next, { resolve, reject });
      socket.send(JSON.stringify({ id: next, method, params, ...(sessionId !== undefined && { sessionId }) }));
    }),
    on: (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]),
    fail,
    gone,
    close: () => socket.close(),
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(cdp));
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)));
  });
}

/** Chromium's fixed flags; a container's /dev/shm is small, so shared memory goes to /tmp. */
export const CHROMIUM_ARGS: readonly string[] = [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync",
  "--hide-scrollbars", "--mute-audio", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
];

/** Chromium leads its own process group, so closing it reaches the renderers and helpers it starts. */
export const CHROMIUM_SPAWN_OPTIONS = { detached: true } as const;

/**
 * Start Chromium headless and read its DevTools endpoint.
 * @param bin - The Chromium program.
 * @param profile - A fresh user-data directory.
 * @returns The process and its endpoint.
 */
function startChromium(bin: string, profile: string): Promise<{ child: ChildProcess; endpoint: string }> {
  const child = spawn(bin, [...CHROMIUM_ARGS, `--user-data-dir=${profile}`, "about:blank"], { ...CHROMIUM_SPAWN_OPTIONS, stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolve, reject) => {
    let seen = "";
    child.stderr.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (match !== null) resolve({ child, endpoint: match[1] ?? "" });
    });
    child.on("error", reject);
    child.on("close", (code) => reject(new Error(`chromium exited ${code}: ${seen.slice(-2000)}`)));
  });
}

/**
 * Kill Chromium's whole process group, wait until it has exited, then remove its profile. Its helpers keep writing
 * into the profile until they are gone, so removing it earlier fails with ENOTEMPTY. A profile that still cannot be
 * removed is logged: the measurement it belongs to stands.
 * @param child - The Chromium process, started with {@link CHROMIUM_SPAWN_OPTIONS}.
 * @param profile - Its user-data directory.
 * @throws {never} Never.
 */
export async function closeChromium(child: ChildProcess, profile: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      if (child.pid === undefined) throw new Error("no pid");
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
  }
  try {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.error("web_animation_profile_cleanup_failed", { profile, err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Load the package in Chromium and measure what the check judges.
 * @param html - The package.
 * @param job - The run.
 * @param settings - Where Chromium and the font set are.
 * @returns The measurements.
 * @throws {Error} When Chromium or CDP fails.
 */
async function measureInChromium(html: string, job: WebAnimationRunBody, settings: WebAnimationRunnerSettings): Promise<WebAnimationCheckObservation> {
  const server = await serveCheck(html, settings.fontsDir);
  const profile = await mkdtemp(join(tmpdir(), "chromium-"));
  const chromium = await startChromium(settings.chromiumBin, profile);
  const cdp = await connectCdp(chromium.endpoint);
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    /**
     * Send a command to the page's session.
     * @param method - The CDP method.
     * @param params - Its parameters.
     * @returns Its result.
     */
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => cdp.send(method, params, sessionId);
    // A crashed page answers nothing more; the run fails now instead of waiting for the job's deadline.
    cdp.on("Inspector.targetCrashed", () => cdp.fail(new Error("the page crashed")));
    const requests: string[] = [];
    cdp.on("Network.requestWillBeSent", (params) => {
      const url = (params["request"] as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && !BROWSER_OWN.has(url)) requests.push(url);
    });
    const loaded = new Promise<void>((resolve) => cdp.on("Page.loadEventFired", () => resolve()));
    for (const domain of ["Network.enable", "Page.enable", "DOM.enable", "CSS.enable"]) await send(domain);
    await send("Emulation.setDeviceMetricsOverride", { width: job.viewport.width, height: job.viewport.height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: CHECK_PAGE });
    await Promise.race([loaded, cdp.gone]);
    /**
     * Evaluate an expression in the page, awaiting a promise it returns.
     * @param expression - The expression.
     * @returns Its value.
     */
    const evaluate = async (expression: string): Promise<unknown> => {
      const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (answer["exceptionDetails"] !== undefined) throw new Error(`the page threw: ${JSON.stringify(answer["exceptionDetails"]).slice(0, 500)}`);
      return (answer["result"] as { value?: unknown } | undefined)?.value;
    };
    const root = await evaluate(`(() => {
      const root = document.querySelector("[data-composition-id]");
      if (!root) return null;
      const read = (name) => { const value = Number(root.getAttribute(name)); return Number.isFinite(value) && root.hasAttribute(name) ? value : null; };
      return { duration: read("data-duration"), width: read("data-width"), height: read("data-height") };
    })()`) as { duration: number | null; width: number | null; height: number | null } | null;
    const durationSeconds = root?.duration ?? null;
    const viewport = root?.width != null && root.height != null ? { width: root.width, height: root.height } : null;
    const empty = { durationSeconds, viewport, seekRepeat: [], seekDirections: [], textFonts: [], requests, packageBytes: Buffer.byteLength(html) };
    if (durationSeconds === null || durationSeconds <= 0) return empty;

    await evaluate("new Promise((resolve) => { const ready = () => window.__playerReady === true ? resolve(true) : setTimeout(ready, 50); ready(); })");
    /**
     * Seek the page and hash a screenshot of the frame it paints.
     * @param time - Seconds.
     * @returns The screenshot's hash.
     */
    const frameAt = async (time: number): Promise<string> => {
      await evaluate(`(async () => {
        window.__player.renderSeek(${time});
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const { data } = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
      return createHash("sha256").update(data).digest("hex");
    };
    const middle = durationSeconds / 2;
    await frameAt(0);
    const forward = await frameAt(middle);
    const again = await frameAt(middle);
    await frameAt(durationSeconds * 0.9);
    const backward = await frameAt(middle);

    const textFonts: WebAnimationCheckObservation["textFonts"] = [];
    const { root: documentNode } = await send("DOM.getDocument", { depth: -1, pierce: true }) as { root: DomNode };
    for (const nodeId of textParents(documentNode)) {
      const { fonts } = await send("CSS.getPlatformFontsForNode", { nodeId }) as { fonts: Array<{ familyName: string; isCustomFont: boolean }> };
      for (const font of fonts) textFonts.push({ family: font.familyName, isCustomFont: font.isCustomFont });
    }
    return { ...empty, seekRepeat: [forward, again], seekDirections: [forward, backward], textFonts };
  } finally {
    cdp.close();
    server.close();
    await closeChromium(chromium.child, profile);
  }
}

/** A node of `DOM.getDocument`. */
interface DomNode {
  nodeId: number;
  nodeType: number;
  nodeValue?: string;
  children?: DomNode[];
  contentDocument?: DomNode;
}

/**
 * The elements that hold visible text directly.
 * @param node - Where to start.
 * @returns Their node ids.
 */
function textParents(node: DomNode): number[] {
  const found: number[] = [];
  const children = [...(node.children ?? []), ...(node.contentDocument === undefined ? [] : [node.contentDocument])];
  if (node.nodeType === 1 && children.some((child) => child.nodeType === 3 && (child.nodeValue ?? "").trim() !== "")) {
    found.push(node.nodeId);
  }
  for (const child of children) found.push(...textParents(child));
  return found;
}

/**
 * Run one web animation and report it.
 * @param job - The run.
 * @param settings - Where the image keeps dsh, Chromium, the runtime and the font set.
 * @returns Nothing; the outcome travels in the report.
 */
export async function runWebAnimation(job: WebAnimationRunBody, settings: WebAnimationRunnerSettings): Promise<void> {
  const steps: unknown[] = [];
  let posted = Promise.resolve();
  /**
   * Post the phase and the steps so far, after every earlier post, so the latest phase is the one that lands last.
   * @param phase - The phase.
   * @returns When it has been posted.
   */
  const progress = (phase: WebAnimationRunPhase): Promise<void> => {
    posted = posted.then(() => post(job.progressUrl, { phase, steps: [...steps] }));
    return posted;
  };
  const work = await mkdtemp(join(tmpdir(), "web-animation-"));
  let ok = false;
  let failureReason = "internal";
  try {
    await writeFile(join(work, "index.html"), compositionTemplate(job));
    await writeFile(join(work, "AGENTS.md"), instructions(job));
    await progress("writing");
    const exit = await runHarness(job, work, settings, (step) => {
      steps.push(step);
      void progress("writing");
    });
    if (exit !== 0) {
      failureReason = "harness_failed";
      throw new Error(`dsh exited ${exit}`);
    }

    await progress("validating");
    const faces = JSON.parse(await readFile(join(settings.fontsDir, `v${job.fontSetVersion}`, "faces.json"), "utf8")) as WebAnimationFontFace[];
    const html = packWebAnimationSource({
      composition: await readFile(join(work, "index.html"), "utf8"),
      runtime: await readFile(settings.runtimeFile, "utf8"),
      bridge: WEB_ANIMATION_BRIDGE_SCRIPT,
      fontStylesheet: buildFontSetStylesheet(job.fontSetVersion, faces),
    });
    failureReason = "validation_failed";
    const verdict = judgeWebAnimationCheck(await measureInChromium(html, job, settings), {
      viewport: job.viewport,
      fps: job.fps,
      durationFrames: job.durationFrames,
      maxPackageBytes: job.maxPackageBytes,
      fontRequestPrefix: `http://127.0.0.1:${CHECK_PORT}/web-animation/fonts/v${job.fontSetVersion}/`,
    });
    steps.push({ check: "package", ok: verdict === null, ...(verdict !== null && { reason: verdict }) });
    if (verdict !== null) {
      failureReason = verdict;
      throw new Error(`the package failed its check: ${verdict}`);
    }

    await progress("saving");
    failureReason = "internal";
    await put(job.packageUrl, html);
    await put(job.manifestUrl, JSON.stringify(buildWebAnimationManifest(job)));
    ok = true;
  } catch (err) {
    console.error("web_animation_run_failed", { failureReason, err: err instanceof Error ? err.message : String(err) });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await posted;
  await post(job.reportUrl, { ok, failureReason: ok ? null : failureReason, cpuUsec: await cpuUsec() });
}
