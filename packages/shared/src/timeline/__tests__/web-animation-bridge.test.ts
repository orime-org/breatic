// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page side of the frame-ready bridge (inner#1711 design §7.2, DD §4.2).
 *
 * The runner inlines `WEB_ANIMATION_BRIDGE_SCRIPT` into every source package after the HyperFrames runtime. The
 * player's own `seek()` rewrites `currentTime` synchronously and cannot say the frame is painted, so the page answers
 * each seek itself: it takes messages only from `window.parent`, says `breatic-bridge-ready` once the runtime sets
 * `window.__playerReady` and again for every `breatic-hello`, and for each `breatic-seek` calls
 * `window.__player.renderSeek(time)`, waits for `document.fonts.ready` and two animation frames, then answers
 * `breatic-frame-ready` with the seek's session and sequence. Both directions post with target origin `*`, because
 * the sandboxed page's origin is null.
 *
 * The contract lives in shared so the host side in web (inner#1711 S8) can drive the same script in its own tests.
 * The script runs here in a `node:vm` context standing in for the sandboxed window; that it runs the same in Chromium
 * inside the player is verified in a real browser.
 */

import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { WEB_ANIMATION_BRIDGE_SCRIPT } from "../web-animation-bridge.js";

/** A posted message and its target origin. */
type Posted = [message: unknown, targetOrigin: string];

/** A stand-in window running the bridge. */
interface Page {
  posted: Posted[];
  renderSeek: ReturnType<typeof vi.fn>;
  /** Deliver a message as if `source` posted it. */
  receive: (data: unknown, source?: unknown) => void;
  /** Run the animation-frame callbacks queued so far, as one frame. */
  frame: () => void;
  /** Let promises and timers the bridge is waiting on run. */
  settle: (rounds?: number) => Promise<void>;
  /** Set a global from inside the page, the way the runtime does. */
  setInPage: (code: string) => void;
  resolveFonts: () => void;
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
}

/**
 * Load the bridge into a fresh stand-in window.
 * @param options - Whether the runtime is ready before the script runs, and whether fonts are already loaded.
 * @returns The page.
 */
function load(options: { readyAtLoad?: boolean; fontsLoaded?: boolean } = {}): Page {
  const posted: Posted[] = [];
  const parent = { postMessage: (message: unknown, targetOrigin: string) => void posted.push([message, targetOrigin]) };
  const listeners: Array<(event: unknown) => void> = [];
  let frames: Array<(time: number) => void> = [];
  let resolveFonts: () => void = () => undefined;
  const fontsReady = options.fontsLoaded === false
    ? new Promise<void>((resolve) => { resolveFonts = resolve; })
    : Promise.resolve();
  const renderSeek = vi.fn();
  const context: Record<string, unknown> = {
    parent,
    top: parent,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener);
    },
    removeEventListener: () => undefined,
    requestAnimationFrame: (callback: (time: number) => void) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => undefined,
    document: { fonts: { ready: fontsReady } },
    __player: { renderSeek },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
  };
  if (options.readyAtLoad) context["__playerReady"] = true;
  context["window"] = context;
  context["self"] = context;
  vm.createContext(context);
  vm.runInContext(WEB_ANIMATION_BRIDGE_SCRIPT, context);

  return {
    posted,
    renderSeek,
    parent,
    resolveFonts: () => resolveFonts(),
    receive: (data, source = parent) => {
      const event = { data, source, origin: "null" };
      for (const listener of listeners) listener(event);
      const onmessage = context["onmessage"];
      if (typeof onmessage === "function") onmessage(event);
    },
    frame: () => {
      const due = frames;
      frames = [];
      for (const callback of due) callback(16);
    },
    settle: async (rounds = 10) => {
      for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    setInPage: (code) => vm.runInContext(code, context),
  };
}

/**
 * Run frames and timers until the predicate holds or the rounds run out.
 * @param page - The page.
 * @param until - What to wait for.
 * @param rounds - How many frame-and-settle rounds at most.
 * @returns Nothing.
 */
async function pump(page: Page, until: () => boolean = () => false, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds && !until(); i += 1) {
    page.frame();
    await page.settle(1);
  }
}

const readyMessages = (page: Page): Posted[] =>
  page.posted.filter(([message]) => (message as { type?: string }).type === "breatic-bridge-ready");
const frameReadyMessages = (page: Page): Posted[] =>
  page.posted.filter(([message]) => (message as { type?: string }).type === "breatic-frame-ready");

/**
 * A page whose runtime is ready and whose first bridge-ready has been sent.
 * @param options - As for {@link load}.
 * @returns The page.
 */
async function readyPage(options: { fontsLoaded?: boolean } = {}): Promise<Page> {
  const page = load({ readyAtLoad: true, ...options });
  await pump(page, () => readyMessages(page).length > 0);
  expect(readyMessages(page)).toHaveLength(1);
  return page;
}

describe("breatic-bridge-ready", () => {
  it("is not sent before the runtime sets window.__playerReady, even when the host says hello", async () => {
    const page = load();
    page.receive({ type: "breatic-hello" });
    await pump(page);

    expect(readyMessages(page)).toEqual([]);
  });

  it("is sent once, to the parent with target origin *, when the runtime becomes ready", async () => {
    const page = load();
    await pump(page);
    page.setInPage("window.__playerReady = true;");
    await pump(page, () => readyMessages(page).length > 0);
    await pump(page);

    expect(readyMessages(page)).toEqual([[{ type: "breatic-bridge-ready" }, "*"]]);
  });

  it("is sent once when the runtime was already ready as the bridge loaded", async () => {
    const page = await readyPage();
    await pump(page);

    expect(readyMessages(page)).toHaveLength(1);
  });

  it("is sent again for every hello from the parent", async () => {
    const page = await readyPage();
    page.receive({ type: "breatic-hello" });
    await pump(page, () => readyMessages(page).length >= 2);
    page.receive({ type: "breatic-hello" });
    await pump(page, () => readyMessages(page).length >= 3);
    await pump(page);

    expect(readyMessages(page)).toEqual([
      [{ type: "breatic-bridge-ready" }, "*"],
      [{ type: "breatic-bridge-ready" }, "*"],
      [{ type: "breatic-bridge-ready" }, "*"],
    ]);
  });

  it("is not sent for a hello from anyone but the parent", async () => {
    const page = await readyPage();
    page.receive({ type: "breatic-hello" }, { postMessage: () => undefined });
    await pump(page);

    expect(readyMessages(page)).toHaveLength(1);
  });
});

describe("breatic-seek and breatic-frame-ready", () => {
  it("renders the seek's time and answers its session and sequence to the parent with target origin *", async () => {
    const page = await readyPage();
    page.receive({ type: "breatic-seek", session: "session-2", sequence: 7, time: 1.25 });
    await pump(page, () => frameReadyMessages(page).length > 0);

    expect(page.renderSeek).toHaveBeenCalledWith(1.25);
    expect(frameReadyMessages(page)).toEqual([[{ type: "breatic-frame-ready", session: "session-2", sequence: 7 }, "*"]]);
  });

  it("does not answer while document.fonts.ready is pending, and answers once it resolves", async () => {
    const page = await readyPage({ fontsLoaded: false });
    page.receive({ type: "breatic-seek", session: "s", sequence: 1, time: 0.5 });
    await pump(page);

    expect(frameReadyMessages(page)).toEqual([]);
    page.resolveFonts();
    await pump(page, () => frameReadyMessages(page).length > 0);
    expect(frameReadyMessages(page)).toEqual([[{ type: "breatic-frame-ready", session: "s", sequence: 1 }, "*"]]);
  });

  it("does not answer before two animation frames have passed after the seek", async () => {
    const page = await readyPage();
    page.receive({ type: "breatic-seek", session: "s", sequence: 1, time: 0.5 });
    await page.settle();
    page.frame();
    await page.settle();

    expect(frameReadyMessages(page)).toEqual([]);
    page.frame();
    await page.settle();
    expect(frameReadyMessages(page)).toEqual([[{ type: "breatic-frame-ready", session: "s", sequence: 1 }, "*"]]);
  });

  it("answers the latest seek with its own session and sequence after the host re-seeks", async () => {
    const page = await readyPage();
    page.receive({ type: "breatic-seek", session: "s", sequence: 1, time: 3 });
    page.receive({ type: "breatic-seek", session: "s2", sequence: 2, time: 1 });
    await pump(page, () => frameReadyMessages(page).some(([message]) => (message as { sequence: number }).sequence === 2));
    await pump(page);

    expect(page.renderSeek).toHaveBeenLastCalledWith(1);
    expect(frameReadyMessages(page)).toContainEqual([{ type: "breatic-frame-ready", session: "s2", sequence: 2 }, "*"]);
  });

  it("ignores a seek from anyone but the parent", async () => {
    const page = await readyPage();
    page.receive({ type: "breatic-seek", session: "s", sequence: 1, time: 1 }, { postMessage: () => undefined });
    await pump(page);

    expect(page.renderSeek).not.toHaveBeenCalled();
    expect(frameReadyMessages(page)).toEqual([]);
  });

  it("ignores a seek without a numeric time, session and sequence", async () => {
    const page = await readyPage();
    for (const data of [
      { type: "breatic-seek", session: "s", sequence: 1 },
      { type: "breatic-seek", session: "s", sequence: 1, time: "1" },
      { type: "breatic-seek", sequence: 1, time: 1 },
      { type: "breatic-seek", session: "s", time: 1 },
    ]) page.receive(data);
    await pump(page);

    expect(page.renderSeek).not.toHaveBeenCalled();
    expect(frameReadyMessages(page)).toEqual([]);
  });

  it("ignores messages of other types and non-object data", async () => {
    const page = await readyPage();
    for (const data of ["breatic-seek", null, 42, { type: "seek", time: 1 }, { type: "breatic-frame-ready", session: "s", sequence: 1 }]) {
      page.receive(data);
    }
    await pump(page);

    expect(page.renderSeek).not.toHaveBeenCalled();
    expect(frameReadyMessages(page)).toEqual([]);
    expect(readyMessages(page)).toHaveLength(1);
  });
});
