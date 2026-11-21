// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client's side of Google sign-in through the system browser (#1599,
 * design §8.2).
 *
 * One sign-in waits at a time. The browser's `breatic://sign-in` link counts
 * only when its challenge matches the sign-in waiting, so a repeated, stale or
 * cancelled link changes nothing. The result is kept until a page takes it,
 * once, and expires with the server's code after five minutes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

import { createBrowserSignIn, parseSignInLink } from "@desktop/main/browser-sign-in.js";

const SERVER = "https://app.example.com";
let now = 0;
const openExternal = vi.fn(async (_url: string) => undefined);

beforeEach(() => {
  now = 1_000_000;
  openExternal.mockClear();
});

/** A sign-in flow on a fixed clock. */
function flow() {
  return createBrowserSignIn({ openExternal, now: () => now, ttlMs: 5 * 60_000 });
}

/**
 * Start a sign-in and read back the challenge the browser was sent.
 * @param signIn - The flow.
 * @param referral - The referral code to carry.
 * @param windowId - The window that asked.
 */
async function started(signIn: ReturnType<typeof flow>, referral: string | null = null, windowId = 1) {
  await signIn.start({ windowId, serverOrigin: SERVER, referralCode: referral });
  const opened = new URL(openExternal.mock.calls.at(-1)![0]);
  return { opened, challenge: opened.searchParams.get("challenge")! };
}

/**
 * The link the browser page opens.
 * @param code - The code.
 * @param challenge - The challenge.
 */
function link(code: string, challenge: string): string {
  return `breatic://sign-in?code=${code}&challenge=${challenge}`;
}

describe("start", () => {
  it("opens the browser on the server's desktop sign-in page with a fresh challenge", async () => {
    const { opened, challenge } = await started(flow());
    expect(opened.origin + opened.pathname).toBe("https://app.example.com/desktop/sign-in");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.searchParams.has("ref")).toBe(false);
  });

  it("carries the referral code", async () => {
    const { opened } = await started(flow(), "FRIEND1");
    expect(opened.searchParams.get("ref")).toBe("FRIEND1");
  });

  it("is pending until it is taken", async () => {
    const signIn = flow();
    expect(signIn.isPending()).toBe(false);
    await started(signIn);
    expect(signIn.isPending()).toBe(true);
  });
});

describe("receive and take", () => {
  it("hands the code and the verifier behind the challenge to the window that asked, once", async () => {
    const signIn = flow();
    const { challenge } = await started(signIn, null, 7);
    expect(signIn.receive(link("c".repeat(43), challenge))).toEqual({ accepted: true, windowId: 7 });
    const result = signIn.take();
    expect(result?.code).toBe("c".repeat(43));
    expect(crypto.createHash("sha256").update(result!.verifier).digest("base64url")).toBe(challenge);
    expect(signIn.take()).toBeNull();
    expect(signIn.isPending()).toBe(false);
  });

  it("ignores a link whose challenge is not the one waiting", async () => {
    const signIn = flow();
    await started(signIn);
    expect(signIn.receive(link("c".repeat(43), "x".repeat(43)))).toEqual({ accepted: false });
    expect(signIn.take()).toBeNull();
  });

  it("ignores the same link a second time", async () => {
    const signIn = flow();
    const { challenge } = await started(signIn);
    signIn.receive(link("c".repeat(43), challenge));
    signIn.take();
    expect(signIn.receive(link("c".repeat(43), challenge))).toEqual({ accepted: false });
  });

  it("ignores a link that arrives after cancel", async () => {
    const signIn = flow();
    const { challenge } = await started(signIn);
    signIn.cancel();
    expect(signIn.receive(link("c".repeat(43), challenge))).toEqual({ accepted: false });
  });

  it("forgets the first sign-in when a second starts", async () => {
    const signIn = flow();
    const first = await started(signIn);
    await started(signIn);
    expect(signIn.receive(link("c".repeat(43), first.challenge))).toEqual({ accepted: false });
  });

  it("drops a result nobody took within the code's lifetime", async () => {
    const signIn = flow();
    const { challenge } = await started(signIn);
    signIn.receive(link("c".repeat(43), challenge));
    now += 5 * 60_000 + 1;
    expect(signIn.take()).toBeNull();
    expect(signIn.isPending()).toBe(false);
  });

  it("drops a wait that saw no link within the code's lifetime", async () => {
    const signIn = flow();
    const { challenge } = await started(signIn);
    now += 5 * 60_000 + 1;
    expect(signIn.receive(link("c".repeat(43), challenge))).toEqual({ accepted: false });
  });
});

describe("parseSignInLink", () => {
  it("reads code and challenge", () => {
    expect(parseSignInLink(link("c".repeat(43), "d".repeat(43)))).toEqual({ code: "c".repeat(43), challenge: "d".repeat(43) });
  });

  it.each([
    "breatic://other?code=a&challenge=b",
    "https://app.example.com/sign-in?code=a&challenge=b",
    "breatic://sign-in?code=a",
    `breatic://sign-in?code=${"c".repeat(43)}&challenge=short`,
    "not a url",
  ])("refuses %s", (input) => {
    expect(parseSignInLink(input)).toBeNull();
  });
});
