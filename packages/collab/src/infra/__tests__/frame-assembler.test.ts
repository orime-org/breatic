// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Per-connection reassembly of chunked collab messages (inner#1585): every
 * transition of the per-connection state table, the process budget and the
 * per-user share, the idle timer, the close codes and the log lines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type * as CoreModule from "@breatic/core";

const { logs } = vi.hoisted(() => ({
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => logs,
}));

import { COLLAB_FRAME_MAX_BYTES, isReauthCloseReason, sendInChunks } from "@breatic/shared";
import { createFrameAssembler } from "@collab/infra/frame-assembler.js";

const F = COLLAB_FRAME_MAX_BYTES;
const M = 10_551_296;
const B = 67_108_864;
const T = 30_000;
const CLOSE = {
  1009: "message too large",
  1013: "reassembly budget exhausted",
  1002: "malformed frame",
  1008: "reassembly idle timeout",
} as const;
const TOO_LARGE = "RangeError: Max payload size exceeded";

/** A crossws peer as the reassembler sees it. */
interface FakePeer {
  id: string;
  remoteAddress: string;
  _hocuspocus?: { socketId: string };
  _internal: { nodeReq: object };
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

/** A crossws message as the reassembler sees it. */
interface FakeMessage {
  rawData: Buffer | string;
  uint8Array: () => Uint8Array;
  text: () => string;
}

/** The error crossws hands to the `error` hook. */
class WSError extends Error {
  override name = "WSError";
}

let nextPeer = 0;

/**
 * A fake peer with its own socket id and address.
 * @param socketId - Whether the peer has a Hocuspocus socket id yet.
 * @returns The peer.
 */
function peer(socketId = true): FakePeer {
  const n = ++nextPeer;
  return {
    id: `p${n}`,
    remoteAddress: `10.0.0.${n}`,
    ...(socketId ? { _hocuspocus: { socketId: `s-${n}` } } : {}),
    _internal: { nodeReq: {} },
    close: vi.fn(),
    send: vi.fn(),
  };
}

/**
 * Deterministic pseudo-random bytes.
 * @param n - Length.
 * @param seed - Seed.
 * @returns The bytes.
 */
function msg(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * A binary frame.
 * @param bytes - Payload.
 * @returns The message.
 */
function bin(bytes: Uint8Array): FakeMessage {
  return { rawData: Buffer.from(bytes), uint8Array: () => bytes, text: () => Buffer.from(bytes).toString() };
}

/**
 * A text frame, which crossws hands over as a string.
 * @param s - Text.
 * @returns The message.
 */
function txt(s: string): FakeMessage {
  return { rawData: s, uint8Array: () => new TextEncoder().encode(s), text: () => s };
}

/**
 * A declaration frame.
 * @param n - Declared bytes.
 * @returns The message.
 */
function decl(n: number): FakeMessage {
  return txt(JSON.stringify({ type: "chunked", bytes: n }));
}

/**
 * The frames the shared sender writes for a message.
 * @param m - Message.
 * @returns The frames as messages.
 */
function frames(m: Uint8Array): FakeMessage[] {
  const out: FakeMessage[] = [];
  sendInChunks(m, (f) => out.push(typeof f === "string" ? txt(f) : bin(f)));
  return out;
}

/**
 * Compare bytes with a memcmp; deep equality on megabyte arrays takes seconds.
 * @param actual - Bytes produced.
 * @param expected - Bytes wanted.
 * @returns Whether they are identical.
 */
function same(actual: unknown, expected: Uint8Array): boolean {
  if (!(actual instanceof Uint8Array)) return false;
  return Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)) === 0;
}

/** The reassembler under test plus the user table its `userOf` reads. */
interface Rig {
  a: ReturnType<typeof createFrameAssembler>;
  users: Map<FakePeer, string>;
  /** Feed one frame. */
  rx: (p: FakePeer, m: FakeMessage) => Uint8Array | undefined;
  /** A new peer owned by a user. */
  own: (user: string | undefined) => FakePeer;
}

/**
 * Build a reassembler.
 * @param opts - Overrides for the three limits.
 * @returns The rig.
 */
function asm(opts: Partial<{ maxMessageBytes: number; budgetBytes: number; idleTimeoutMs: number }> = {}): Rig {
  const users = new Map<FakePeer, string>();
  const a = createFrameAssembler({
    maxMessageBytes: opts.maxMessageBytes ?? M,
    budgetBytes: opts.budgetBytes ?? B,
    idleTimeoutMs: opts.idleTimeoutMs ?? T,
    userOf: (p: unknown) => users.get(p as FakePeer),
  });
  return {
    a,
    users,
    rx: (p, m) => a.receiveFrame(p, m),
    own: (user) => {
      const p = peer();
      if (user !== undefined) users.set(p, user);
      return p;
    },
  };
}

/**
 * Feed a peer every frame and return what each one produced.
 * @param r - Rig.
 * @param p - Peer.
 * @param fs - Frames.
 * @returns The results in order.
 */
function feed(r: Rig, p: FakePeer, fs: FakeMessage[]): Array<Uint8Array | undefined> {
  return fs.map((f) => r.rx(p, f));
}

/**
 * The identity fields a log line carries for a peer.
 * @param p - Peer.
 * @param user - Its user, or null.
 * @returns The fields.
 */
function ID(p: FakePeer, user: string | null): Record<string, unknown> {
  return { socketId: p._hocuspocus?.socketId ?? null, userId: user, remoteAddress: p.remoteAddress };
}

/**
 * The only call at a level, which must carry this event. Asserting the three
 * identity keys here makes every rejection case also check A27.
 * @param level - Log level.
 * @param event - Event name.
 * @returns The first argument of that call.
 */
function only(level: "warn" | "error", event: string): { ctx: Record<string, unknown>; err?: Error } {
  expect(logs[level]).toHaveBeenCalledTimes(1);
  const [arg, name] = logs[level].mock.calls[0] as [{ ctx: Record<string, unknown>; err?: Error }, string];
  expect(name).toBe(event);
  for (const key of ["socketId", "userId", "remoteAddress"]) expect(arg.ctx).toHaveProperty(key);
  return arg;
}

/**
 * Assert a peer was closed once by us with this code and its reason.
 * @param p - Peer.
 * @param code - Close code.
 */
function closedWith(p: FakePeer, code: keyof typeof CLOSE): void {
  expect(p.close).toHaveBeenCalledTimes(1);
  expect(p.close).toHaveBeenCalledWith(code, CLOSE[code]);
}

/**
 * Whether a peer is now dropping frames.
 * @param r - Rig.
 * @param p - Peer.
 * @returns True when a small binary frame is swallowed.
 */
function dropping(r: Rig, p: FakePeer): boolean {
  return r.rx(p, bin(msg(2_048))) === undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("frame assembler — idle and complete messages", () => {
  it.each([1, 2_048, F])("A01 passes a %i-byte binary frame through untouched while idle", (n) => {
    const r = asm();
    const p = r.own("u");
    const m = msg(n);
    expect(r.rx(p, bin(m))).toEqual(m);
    expect(r.a.inUseBytes()).toBe(0);
    expect(r.a.userInUse().size).toBe(0);
    expect(p.close).not.toHaveBeenCalled();
    for (const fn of Object.values(logs)) expect(fn).not.toHaveBeenCalled();
  });

  it("A02 reassembles the smallest chunked message and returns the reservation", () => {
    const r = asm();
    const p = r.own("u");
    const m = msg(131_073);
    const [d, c1, c2] = frames(m);
    expect(r.rx(p, d!)).toBeUndefined();
    expect(r.a.inUseBytes()).toBe(131_073);
    expect(r.a.userInUse()).toEqual(new Map([["u", 131_073]]));
    expect(r.rx(p, c1!)).toBeUndefined();
    expect(r.a.inUseBytes()).toBe(131_073);
    expect(same(r.rx(p, c2!), m)).toBe(true);
    expect(r.a.inUseBytes()).toBe(0);
    expect(r.a.userInUse().size).toBe(0);
    expect(p.close).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("A02 accepts a declaration carrying an extra key", () => {
    const r = asm();
    const p = r.own("u");
    const m = msg(131_073);
    const [, c1, c2] = frames(m);
    expect(r.rx(p, txt(JSON.stringify({ type: "chunked", bytes: 131_073, extra: 1 })))).toBeUndefined();
    expect(r.rx(p, c1!)).toBeUndefined();
    expect(same(r.rx(p, c2!), m)).toBe(true);
    expect(p.close).not.toHaveBeenCalled();
  });

  it.each([1_200_000, 3_145_728, M])("A03 reassembles %i bytes, returning only on the last frame", (n) => {
    const r = asm();
    const p = r.own("u");
    const m = msg(n);
    const out = feed(r, p, frames(m));
    expect(out.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(same(out.at(-1), m)).toBe(true);
    expect(r.a.inUseBytes()).toBe(0);
  });
});

describe("frame assembler — limits", () => {
  it("A04 closes 1009 on a declaration over the per-connection cap", () => {
    const r = asm();
    const p = r.own("u");
    expect(r.rx(p, decl(M + 1))).toBeUndefined();
    closedWith(p, 1009);
    expect(only("warn", "collab_message_too_large").ctx).toMatchObject({
      ...ID(p, "u"), source: "declared", bytes: M + 1, limit: M,
    });
    expect(r.a.inUseBytes()).toBe(0);
    expect(dropping(r, p)).toBe(true);
  });

  it("A05 (a) lets one user hold up to one full message across connections", () => {
    const r = asm();
    const p1 = r.own("u");
    const p2 = r.own("u");
    r.rx(p1, decl(10_000_000));
    r.rx(p2, decl(551_296));
    expect(p1.close).not.toHaveBeenCalled();
    expect(p2.close).not.toHaveBeenCalled();
    expect(r.a.userInUse().get("u")).toBe(M);
    expect(r.a.inUseBytes()).toBe(M);
  });

  it("A05 (b) closes 1013 one byte past the user's share and leaves the counts", () => {
    const r = asm();
    const p1 = r.own("u");
    const p2 = r.own("u");
    r.rx(p1, decl(10_000_000));
    r.rx(p2, decl(551_297));
    closedWith(p2, 1013);
    expect(only("warn", "collab_reassembly_budget_exhausted").ctx).toMatchObject({
      ...ID(p2, "u"), scope: "user", bytes: 551_297, userInUseBytes: 10_000_000, inUseBytes: 10_000_000, budgetBytes: B,
    });
    expect(r.a.userInUse().get("u")).toBe(10_000_000);
    expect(r.a.inUseBytes()).toBe(10_000_000);
  });

  it("A05 (c) a full user cannot add more while another user still can", () => {
    const r = asm();
    const p1 = r.own("u");
    const p2 = r.own("u");
    r.rx(p1, decl(10_000_000));
    r.rx(p2, decl(551_296));
    const p3 = r.own("u");
    r.rx(p3, decl(131_073));
    closedWith(p3, 1013);
    expect(only("warn", "collab_reassembly_budget_exhausted").ctx).toMatchObject({ scope: "user", userInUseBytes: M });
    const q = r.own("v");
    r.rx(q, decl(M));
    expect(q.close).not.toHaveBeenCalled();
    expect(r.a.userInUse()).toEqual(new Map([["u", M], ["v", M]]));
    expect(r.a.inUseBytes()).toBe(2 * M);
  });

  it("A05 (d) reports the user's share first when both the share and the budget are short", () => {
    const r = asm();
    const p1 = r.own("u");
    r.rx(p1, decl(10_000_000));
    for (let i = 2; i <= 6; i++) r.rx(r.own(`u${i}`), decl(M));
    expect(r.a.inUseBytes()).toBe(62_756_480);
    const p2 = r.own("u");
    r.rx(p2, decl(4_352_385));
    closedWith(p2, 1013);
    expect(only("warn", "collab_reassembly_budget_exhausted").ctx).toMatchObject({
      ...ID(p2, "u"), scope: "user", bytes: 4_352_385, userInUseBytes: 10_000_000, inUseBytes: 62_756_480, budgetBytes: B,
    });
  });

  it("A35 acknowledges the declaration and every chunk short of the last with one [0] frame", () => {
    const r = asm();
    const p = r.own("u");
    const m = msg(2 * F + 1, 5);
    const fs = frames(m);
    expect(fs).toHaveLength(4);
    const sent: number[] = [];
    fs.forEach((f, i) => {
      r.rx(p, f);
      sent.push(p.send.mock.calls.length);
      if (i < 3) expect(p.send).toHaveBeenLastCalledWith(new Uint8Array([0]));
    });
    expect(sent).toEqual([1, 2, 3, 3]);
  });

  it("A36 acknowledges nothing for an idle frame or a refused one", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, bin(msg(2_048)));
    r.rx(p, decl(M + 1));
    const q = r.own("v");
    r.rx(q, decl(F + 1));
    r.rx(q, bin(msg(F + 2)));
    expect(p.send).not.toHaveBeenCalled();
    expect(q.send).toHaveBeenCalledTimes(1);
  });

  it("A34 a user keeps the rest of their share when one of two messages completes", () => {
    const r = asm();
    const p1 = r.own("u");
    const p2 = r.own("u");
    const m = msg(F + 1, 3);
    const [header, ...chunks] = frames(m);
    r.rx(p1, header!);
    r.rx(p2, decl(F + 1));
    expect(r.a.userInUse().get("u")).toBe(2 * (F + 1));
    expect(same(feed(r, p1, chunks).at(-1), m)).toBe(true);
    expect(r.a.userInUse().get("u")).toBe(F + 1);
    expect(r.a.inUseBytes()).toBe(F + 1);
    const p3 = r.own("u");
    r.rx(p3, decl(M - F));
    closedWith(p3, 1013);
    expect(only("warn", "collab_reassembly_budget_exhausted").ctx).toMatchObject({
      ...ID(p3, "u"), scope: "user", bytes: M - F, userInUseBytes: F + 1, inUseBytes: F + 1,
    });
  });

  it("A06 refuses past the process budget while reassemblies already running finish", () => {
    const r = asm();
    const holders = [1, 2, 3, 4, 5, 6].map((i) => r.own(`u${i}`));
    const m1 = msg(M, 11);
    const u1Frames = frames(m1);
    r.rx(holders[0]!, u1Frames[0]!);
    for (const h of holders.slice(1)) r.rx(h, decl(M));
    expect(r.a.inUseBytes()).toBe(6 * M);

    const a = r.own("u7");
    r.rx(a, decl(3_801_089));
    closedWith(a, 1013);
    expect(only("warn", "collab_reassembly_budget_exhausted").ctx).toMatchObject({
      scope: "process", bytes: 3_801_089, userInUseBytes: 0, inUseBytes: 6 * M, budgetBytes: B,
    });

    const b = r.own("u7");
    r.rx(b, decl(3_801_088));
    expect(b.close).not.toHaveBeenCalled();
    expect(r.a.inUseBytes()).toBe(B);

    logs.warn.mockClear();
    const c = r.own("u8");
    r.rx(c, decl(131_073));
    closedWith(c, 1013);
    expect(only("warn", "collab_reassembly_budget_exhausted").ctx).toMatchObject({ scope: "process", inUseBytes: B });

    const d = r.own("u8");
    const small = msg(2_048);
    expect(r.rx(d, bin(small))).toEqual(small);
    expect(d.close).not.toHaveBeenCalled();

    const out = feed(r, holders[0]!, u1Frames.slice(1));
    expect(same(out.at(-1), m1)).toBe(true);
    expect(r.a.inUseBytes()).toBe(B - M);
    expect(r.a.userInUse().has("u1")).toBe(false);
    for (const h of holders) expect(h.close).not.toHaveBeenCalled();
  });

  it("A07 gives each connection without a user its own share, keyed by the peer", () => {
    const r = asm();
    const p1 = r.own(undefined);
    const p2 = r.own(undefined);
    const m = msg(M, 3);
    const fs = frames(m);
    r.rx(p1, fs[0]!);
    r.rx(p2, decl(M));
    expect(p1.close).not.toHaveBeenCalled();
    expect(p2.close).not.toHaveBeenCalled();
    expect(r.a.inUseBytes()).toBe(2 * M);
    expect(r.a.userInUse().size).toBe(2);
    expect(r.a.userInUse().get(p1)).toBe(M);
    expect(r.a.userInUse().get(p2)).toBe(M);

    const p3 = r.own(undefined);
    r.rx(p3, decl(M + 1));
    closedWith(p3, 1009);
    expect(only("warn", "collab_message_too_large").ctx.userId).toBeNull();

    feed(r, p1, fs.slice(1));
    expect(r.a.userInUse().has(p1)).toBe(false);
    expect(r.a.userInUse().size).toBe(1);
  });

  it("A08 with no document cap one account can fill the budget", () => {
    const r = asm({ maxMessageBytes: B, budgetBytes: B });
    const p = r.own("u");
    r.rx(p, decl(B));
    expect(p.close).not.toHaveBeenCalled();
    expect(r.a.inUseBytes()).toBe(B);
    const q = r.own("v");
    r.rx(q, decl(131_073));
    closedWith(q, 1013);
    expect(only("warn", "collab_reassembly_budget_exhausted").ctx).toMatchObject({ scope: "process" });
  });

  it("A09 with a tiny document cap no declaration is accepted", () => {
    const r = asm({ maxMessageBytes: F, budgetBytes: 2 * F });
    const p1 = r.own("u");
    const m = msg(F);
    expect(r.rx(p1, bin(m))).toEqual(m);
    const p2 = r.own("u");
    r.rx(p2, decl(131_073));
    closedWith(p2, 1009);
    expect(only("warn", "collab_message_too_large").ctx).toMatchObject({ source: "declared", bytes: 131_073, limit: F });
  });
});

describe("frame assembler — malformed sequences", () => {
  it.each([
    ["hello", 5],
    ["", 0],
    ["not json{", 9],
    ["中", 3],
    ['{"type":"chunked","bytes":131072}', 33],
    ['{"type":"chunked","bytes":"131073"}', 35],
    ['{"type":"chunked"}', 18],
    ['{"bytes":131073}', 16],
  ])("A10 closes 1002 bad_header on the idle text %j", (text, frameBytes) => {
    const r = asm();
    const p = r.own("u");
    expect(r.rx(p, txt(text))).toBeUndefined();
    closedWith(p, 1002);
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({
      ...ID(p, "u"), reason: "bad_header", frameBytes, bytes: null, receivedBytes: 0,
    });
    expect(r.a.inUseBytes()).toBe(0);
    expect(dropping(r, p)).toBe(true);
  });

  it.each([
    ["a valid declaration", () => decl(131_073)],
    ["a declaration over the cap", () => decl(M + 1)],
    ["plain text", () => txt("hello")],
  ])("A11 closes 1002 text_during_reassembly on %s mid-message", (_label, make) => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(3 * F));
    r.rx(p, bin(msg(F)));
    const frame = make();
    r.rx(p, frame);
    closedWith(p, 1002);
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({
      reason: "text_during_reassembly", frameBytes: Buffer.byteLength(frame.text()), bytes: 3 * F, receivedBytes: F,
    });
    expect(r.a.inUseBytes()).toBe(0);
    expect(r.a.userInUse().has("u")).toBe(false);
  });

  it("A11 a declaration mid-message is malformed even when the budget would refuse it", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(3 * F));
    r.rx(p, bin(msg(F)));
    for (let i = 1; i <= 6; i++) r.rx(r.own(`u${i}`), decl(M));
    r.rx(r.own("u7"), decl(3_307_872));
    expect(B - r.a.inUseBytes()).toBe(100_000);
    r.rx(p, decl(131_073));
    closedWith(p, 1002);
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({ reason: "text_during_reassembly" });
    expect(r.a.inUseBytes()).toBe(B - 100_000 - 3 * F);
  });

  it.each([
    ["a short first chunk", [F - 1], F - 1, 0],
    ["a short middle chunk", [F, 1], 1, F],
    ["an empty chunk", [0], 0, 0],
  ])("A12 closes 1002 short_chunk on %s", (_label, sizes, frameBytes, receivedBytes) => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(3 * F));
    for (const n of sizes) r.rx(p, bin(msg(n)));
    closedWith(p, 1002);
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({
      reason: "short_chunk", frameBytes, bytes: 3 * F, receivedBytes,
    });
    expect(r.a.inUseBytes()).toBe(0);
  });

  it("A12 (d) a short last chunk completes the message", () => {
    const r = asm();
    const p = r.own("u");
    const m = msg(262_145);
    const out = feed(r, p, frames(m));
    expect(same(out.at(-1), m)).toBe(true);
    expect(p.close).not.toHaveBeenCalled();
  });

  it("A13 (a) closes 1002 overflow when a chunk runs past the declaration below the cap", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(263_144));
    r.rx(p, bin(msg(F)));
    r.rx(p, bin(msg(F)));
    expect(p.close).not.toHaveBeenCalled();
    expect(r.rx(p, bin(msg(F)))).toBeUndefined();
    closedWith(p, 1002);
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({
      reason: "overflow", frameBytes: F, bytes: 263_144, receivedBytes: 2 * F,
    });
    expect(r.a.inUseBytes()).toBe(0);
  });

  it("A13 (b) a chunk both short and past the declaration is an overflow", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(131_172));
    r.rx(p, bin(msg(F)));
    expect(r.rx(p, bin(msg(200)))).toBeUndefined();
    closedWith(p, 1002);
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({
      reason: "overflow", frameBytes: 200, bytes: 131_172, receivedBytes: F,
    });
    expect(r.a.inUseBytes()).toBe(0);
  });

  it.each([
    [65_535, "complete"],
    [65_536, "overflow"],
    [65_537, "received"],
  ])("A14 the 81st chunk of %i bytes after declaring M - 1 gives %s", (last, outcome) => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M - 1));
    for (let i = 0; i < 80; i++) r.rx(p, bin(msg(F, i + 1)));
    const result = r.rx(p, bin(msg(last, 99)));
    if (outcome === "complete") {
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result!.byteLength).toBe(M - 1);
      expect(p.close).not.toHaveBeenCalled();
      return;
    }
    expect(result).toBeUndefined();
    if (outcome === "overflow") {
      closedWith(p, 1002);
      expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({
        reason: "overflow", frameBytes: 65_536, bytes: M - 1, receivedBytes: 80 * F,
      });
    } else {
      closedWith(p, 1009);
      expect(only("warn", "collab_message_too_large").ctx).toMatchObject({ source: "received", bytes: M + 1, limit: M });
    }
    expect(r.a.inUseBytes()).toBe(0);
    expect(dropping(r, p)).toBe(true);
  });
});

describe("frame assembler — idle timer", () => {
  it("A15 (a) closes 1008 when the next chunk is 30 s late", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M));
    r.rx(p, bin(msg(F)));
    vi.advanceTimersByTime(T - 1);
    expect(p.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    closedWith(p, 1008);
    expect(only("warn", "collab_reassembly_idle_timeout").ctx).toMatchObject({ ...ID(p, "u"), receivedBytes: F, bytes: M });
    expect(r.a.inUseBytes()).toBe(0);
  });

  it("A15 (b) every chunk restarts the timer", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M));
    r.rx(p, bin(msg(F)));
    vi.advanceTimersByTime(T - 1);
    r.rx(p, bin(msg(F)));
    vi.advanceTimersByTime(T - 1);
    expect(p.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    closedWith(p, 1008);
    expect(only("warn", "collab_reassembly_idle_timeout").ctx).toMatchObject({ receivedBytes: 2 * F });
  });

  it("A15 (c) a declaration with no chunk at all times out", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M));
    vi.advanceTimersByTime(T);
    closedWith(p, 1008);
    expect(only("warn", "collab_reassembly_idle_timeout").ctx).toMatchObject({ receivedBytes: 0 });
  });

  it("A16 holds no timer after a message completes", () => {
    const r = asm();
    const p = r.own("u");
    feed(r, p, frames(msg(131_073)));
    vi.advanceTimersByTime(60_000);
    expect(p.close).not.toHaveBeenCalled();
    for (const fn of Object.values(logs)) expect(fn).not.toHaveBeenCalled();
    const small = msg(2_048);
    expect(r.rx(p, bin(small))).toEqual(small);
  });

  it("A17 a rejected connection is never closed a second time", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(3 * F));
    r.rx(p, bin(msg(F - 1)));
    vi.advanceTimersByTime(60_000);
    expect(p.close).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });

  it("A31 a connection that only sent small frames has no timer", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, bin(msg(2_048)));
    vi.advanceTimersByTime(60_000);
    expect(p.close).not.toHaveBeenCalled();
    for (const fn of Object.values(logs)) expect(fn).not.toHaveBeenCalled();
  });

  it("A32 the reservation is the declaration, not the bytes received", () => {
    const r = asm();
    const p = r.own("u");
    const fs = frames(msg(3_145_728));
    r.rx(p, fs[0]!);
    for (const f of fs.slice(1, 24)) {
      r.rx(p, f);
      expect(r.a.inUseBytes()).toBe(3_145_728);
      expect(r.a.userInUse().get("u")).toBe(3_145_728);
    }
  });
});

describe("frame assembler — ws errors and closes", () => {
  it("A18 a ws error mid-message returns the reservation at once and never times out", () => {
    const r = asm();
    const q = r.own("v");
    r.rx(q, decl(1_000_000));
    const p = r.own("u");
    r.rx(p, decl(M));
    r.rx(p, bin(msg(F)));
    const err = new WSError(TOO_LARGE);
    r.a.onPeerError(p, err);
    expect(r.a.inUseBytes()).toBe(1_000_000);
    expect(r.a.userInUse()).toEqual(new Map([["v", 1_000_000]]));
    const line = only("warn", "collab_frame_too_large");
    expect(line.ctx).toMatchObject({ ...ID(p, "u"), limit: F });
    expect(line.err).toBe(err);
    expect(p.close).not.toHaveBeenCalled();
    // q keeps sending so only p's timer could fire.
    vi.advanceTimersByTime(T - 1);
    r.rx(q, bin(msg(F)));
    vi.advanceTimersByTime(T - 1);
    r.rx(q, bin(msg(F)));
    vi.advanceTimersByTime(2);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(p.close).not.toHaveBeenCalled();
    expect(r.rx(p, bin(msg(F)))).toBeUndefined();
    r.a.onPeerClose(p, { code: 1009, reason: "" });
    expect(r.a.inUseBytes()).toBe(1_000_000);
  });

  it("A19 (a) an oversized frame while idle is logged as too large", () => {
    const r = asm();
    const p = r.own("u");
    const err = new WSError(TOO_LARGE);
    r.a.onPeerError(p, err);
    const line = only("warn", "collab_frame_too_large");
    expect(line.ctx).toMatchObject({ ...ID(p, "u"), limit: F });
    expect(line.err).toBe(err);
    expect(p.close).not.toHaveBeenCalled();
    expect(dropping(r, p)).toBe(true);
    expect(r.a.inUseBytes()).toBe(0);
  });

  it("A19 (b) any other ws error is a socket error", () => {
    const r = asm();
    const p = r.own("u");
    const err = new WSError("Error: read ECONNRESET");
    r.a.onPeerError(p, err);
    const line = only("error", "collab_socket_error");
    expect(line.ctx).toMatchObject(ID(p, "u"));
    expect(line.err).toBe(err);
    expect(logs.warn).not.toHaveBeenCalled();
    expect(p.close).not.toHaveBeenCalled();
    expect(dropping(r, p)).toBe(true);
  });

  it("A19 (c) a ws error that is not an Error is still logged as a socket error", () => {
    const r = asm();
    const p = r.own("u");
    r.a.onPeerError(p, "boom");
    const line = only("error", "collab_socket_error");
    expect(line.ctx).toMatchObject(ID(p, "u"));
    expect(line.err).toBe("boom");
    expect(dropping(r, p)).toBe(true);
  });

  it("A20 a ws error after we closed is logged and changes nothing", () => {
    const r = asm();
    const q = r.own("v");
    r.rx(q, decl(1_000_000));
    const p = r.own("u");
    r.rx(p, txt("hello"));
    r.a.onPeerError(p, new WSError("Error: read ECONNRESET"));
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(logs.error.mock.calls[0]?.[1]).toBe("collab_socket_error");
    expect(p.close).toHaveBeenCalledTimes(1);
    expect(r.a.inUseBytes()).toBe(1_000_000);
  });

  it("A21 drops every frame after we closed, without logging them", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M + 1));
    for (const f of [bin(msg(F)), decl(131_073), txt("hello"), bin(msg(1))]) expect(r.rx(p, f)).toBeUndefined();
    expect(r.a.inUseBytes()).toBe(0);
    expect(r.a.userInUse().size).toBe(0);
    expect(p.close).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });

  it("A22 a close mid-message returns everything and leaves no timer", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M));
    for (let i = 0; i < 3; i++) r.rx(p, bin(msg(F)));
    r.a.onPeerClose(p, { code: 1006, reason: "" });
    vi.advanceTimersByTime(60_000);
    expect(r.a.inUseBytes()).toBe(0);
    expect(r.a.userInUse().size).toBe(0);
    expect(p.close).not.toHaveBeenCalled();
    for (const fn of Object.values(logs)) expect(fn).not.toHaveBeenCalled();
  });

  it("A23 closing an idle connection touches no one else's reservation", () => {
    const r = asm();
    const q = r.own("v");
    r.rx(q, decl(1_000_000));
    const p = r.own("u");
    r.rx(p, bin(msg(2_048)));
    r.a.onPeerClose(p, { code: 1000, reason: "" });
    expect(r.a.inUseBytes()).toBe(1_000_000);
    expect(r.a.userInUse()).toEqual(new Map([["v", 1_000_000]]));
  });

  it("A24 the close hook deletes the record of a closed connection", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M + 1));
    r.a.onPeerClose(p, { code: 1009, reason: "" });
    const small = msg(2_048);
    expect(r.rx(p, bin(small))).toEqual(small);
  });

  it("A25 three clean-ups of one connection return its reservation once", () => {
    const r = asm();
    const p = r.own("u");
    r.rx(p, decl(M));
    r.rx(p, bin(msg(F)));
    vi.advanceTimersByTime(T - 1);
    const q = r.own("v");
    r.rx(q, decl(1_000_000));
    const steps = [
      (): void => { vi.advanceTimersByTime(1); },
      (): void => { r.a.onPeerError(p, new WSError("Error: read ECONNRESET")); },
      (): void => { r.a.onPeerClose(p, { code: 1008, reason: "" }); },
    ];
    for (const step of steps) {
      step();
      expect(r.a.inUseBytes()).toBe(1_000_000);
      expect(r.a.userInUse()).toEqual(new Map([["v", 1_000_000]]));
    }
  });

  it("A26 (a) logs a null socket id before Hocuspocus assigned one", () => {
    const r = asm();
    const p = peer(false);
    r.users.set(p, "u");
    r.rx(p, txt("hello"));
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({ socketId: null, userId: "u", remoteAddress: p.remoteAddress });
  });

  it("A26 (b) logs a null address when the socket no longer reports one", () => {
    const r = asm();
    const p = r.own("u");
    Reflect.deleteProperty(p, "remoteAddress");
    r.rx(p, txt("hello"));
    expect(only("warn", "collab_frame_malformed").ctx).toMatchObject({ socketId: p._hocuspocus?.socketId, userId: "u", remoteAddress: null });
  });

  it("A28 a declaration does not allocate its buffer up front", () => {
    const r = asm();
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 1; i <= 6; i++) r.rx(r.own(`u${i}`), decl(M));
    const after = process.memoryUsage().arrayBuffers;
    expect(after - before).toBeLessThan(M);
  });

  it("A30 a stalled connection holds its user's share until it times out", () => {
    const r = asm();
    const p1 = r.own("u");
    r.rx(p1, decl(6_000_000));
    r.rx(p1, bin(msg(F)));
    const p2 = r.own("u");
    r.rx(p2, decl(6_000_000));
    closedWith(p2, 1013);
    expect(logs.warn.mock.calls[0]?.[0]).toMatchObject({ ctx: { scope: "user", userInUseBytes: 6_000_000 } });
    vi.advanceTimersByTime(T);
    closedWith(p1, 1008);
    const p3 = r.own("u");
    r.rx(p3, decl(6_000_000));
    expect(p3.close).not.toHaveBeenCalled();
    expect(r.a.userInUse().get("u")).toBe(6_000_000);
  });

  it("A33 our close reasons are fixed and none asks the browser to re-authenticate", () => {
    const cases: Array<[keyof typeof CLOSE, (r: Rig, p: FakePeer) => void]> = [
      [1009, (r, p) => { r.rx(p, decl(M + 1)); }],
      [1013, (r, p) => { r.rx(r.own("u"), decl(M)); r.rx(p, decl(131_073)); }],
      [1002, (r, p) => { r.rx(p, txt("hello")); }],
      [1008, (r, p) => { r.rx(p, decl(M)); vi.advanceTimersByTime(T); }],
    ];
    for (const [code, run] of cases) {
      const r = asm();
      const p = r.own("u");
      run(r, p);
      expect(p.close).toHaveBeenCalledWith(code, CLOSE[code]);
      expect(isReauthCloseReason(CLOSE[code])).toBe(false);
    }
  });
});

/** Reference state of one peer in the model. */
type ModelPeer =
  | { s: "idle" }
  | { s: "assembling"; bytes: number; received: number; chunks: Uint8Array[]; deadline: number }
  | { s: "closed" };

describe("frame assembler — properties", () => {
  it("AP01 matches a reference model over any multi-user event sequence", () => {
    const params = fc.constantFrom(
      { M: F + 7, B: 2 * (F + 7), T: 1_000 },
      { M: 3 * F + 7, B: 2 * (3 * F + 7), T: 1_000 },
      { M: 524_288, B: 524_288, T: 1_000 },
    );
    const kinds = ["full", "full", "full", "exactLast", "lastMinus1", "short", "overflowWithinM", "overflowPastM", "empty"] as const;
    const command = fc.oneof(
      { weight: 3, arbitrary: fc.record({ k: fc.constant("declare" as const), p: fc.nat(5), pick: fc.nat(8), r: fc.nat() }) },
      { weight: 6, arbitrary: fc.record({ k: fc.constant("chunk" as const), p: fc.nat(5), kind: fc.constantFrom(...kinds) }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("small" as const), p: fc.nat(5), n: fc.integer({ min: 0, max: F }) }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("text" as const), p: fc.nat(5), s: fc.string({ maxLength: 40 }) }) },
      { weight: 3, arbitrary: fc.record({ k: fc.constant("advance" as const), pick: fc.nat(3), r: fc.nat(2_000) }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("close" as const), p: fc.nat(5) }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("error" as const), p: fc.nat(5), tooLarge: fc.boolean() }) },
    );
    fc.assert(
      fc.property(params, fc.array(fc.constantFrom("a", "b", "c", undefined), { minLength: 2, maxLength: 6 }), fc.array(command, { maxLength: 60, size: "max" }), (lim, owners, cmds) => {
        vi.clearAllTimers();
        vi.clearAllMocks();
        const r = asm({ maxMessageBytes: lim.M, budgetBytes: lim.B, idleTimeoutMs: lim.T });
        const peers = owners.map((u) => r.own(u));
        const model = new Map<FakePeer, ModelPeer>(peers.map((p) => [p, { s: "idle" }]));
        const keyOf = (p: FakePeer): unknown => r.users.get(p) ?? p;
        const userIn = new Map<unknown, number>();
        let inUse = 0;
        let now = 0;
        let seed = 1;

        const release = (p: FakePeer): void => {
          const st = model.get(p)!;
          if (st.s !== "assembling") return;
          inUse -= st.bytes;
          const k = keyOf(p);
          const left = (userIn.get(k) ?? 0) - st.bytes;
          if (left === 0) userIn.delete(k); else userIn.set(k, left);
        };
        const reject = (p: FakePeer, code: keyof typeof CLOSE): keyof typeof CLOSE => {
          release(p);
          model.set(p, { s: "closed" });
          return code;
        };

        for (const c of cmds) {
          const warnBefore = logs.warn.mock.calls.length;
          const errorBefore = logs.error.mock.calls.length;
          const closesBefore = peers.map((p) => p.close.mock.calls.length);
          let expectedReturn: Uint8Array | undefined;
          const expectedCloses = new Map<FakePeer, keyof typeof CLOSE>();
          // Each refusal as "event:reason|scope|source", so the kind of refusal is checked too.
          const expectedWarns: string[] = [];
          let expectedError = 0;

          if (c.k === "advance") {
            // T - 1 and a part of T let a chunk land inside a window that a missing timer reset would close.
            const ms = [lim.T - 1, lim.T, Math.floor(lim.T / 2), c.r % lim.T][c.pick]!;
            now += ms;
            for (const p of peers) {
              const st = model.get(p)!;
              if (st.s === "assembling" && st.deadline <= now) {
                expectedCloses.set(p, reject(p, 1008));
                expectedWarns.push("collab_reassembly_idle_timeout:");
              }
            }
            vi.advanceTimersByTime(ms);
          } else {
            // A chunk goes to a connection that is reassembling whenever there is one,
            // so the overflow, short-chunk and timer paths are reached often.
            const assembling = peers.filter((q) => model.get(q)!.s === "assembling");
            const p = c.k === "chunk" && assembling.length > 0 ? assembling[c.p % assembling.length]! : peers[c.p % peers.length]!;
            const st = model.get(p)!;
            if (c.k === "close") {
              release(p);
              model.set(p, { s: "idle" });
              r.a.onPeerClose(p, { code: 1000, reason: "" });
            } else if (c.k === "error") {
              if (c.tooLarge) expectedWarns.push("collab_frame_too_large:"); else expectedError++;
              if (st.s !== "closed") { release(p); model.set(p, { s: "closed" }); }
              r.a.onPeerError(p, new WSError(c.tooLarge ? TOO_LARGE : "Error: read ECONNRESET"));
            } else {
              let frame: FakeMessage;
              if (c.k === "declare") {
                const bothShort = Math.max(lim.M - (userIn.get(keyOf(p)) ?? 0), lim.B - inUse, F) + 1;
                const choices = [F, F + 1, lim.M - 1, lim.M, lim.M + 1, lim.B - inUse, lim.B - inUse + 1, bothShort, F + 1 + (c.r % (lim.M - F + 1))];
                const bytes = choices[c.pick % choices.length]!;
                frame = decl(bytes);
              } else if (c.k === "text") {
                frame = txt(c.s);
              } else if (c.k === "small") {
                frame = bin(new Uint8Array(c.n).fill(seed++ % 251 + 1));
              } else {
                const rem = st.s === "assembling" ? st.bytes - st.received : F;
                const received = st.s === "assembling" ? st.received : 0;
                const len = {
                  full: F,
                  exactLast: Math.min(rem, F),
                  lastMinus1: Math.max(Math.min(rem, F) - 1, 0),
                  short: F - 1,
                  overflowWithinM: Math.min(F, rem + 1),
                  overflowPastM: Math.max(0, Math.min(F, lim.M - received + 1)),
                  empty: 0,
                }[c.kind];
                frame = bin(new Uint8Array(len).fill(seed++ % 251 + 1));
              }

              if (st.s === "closed") {
                // dropped: no return, no close, no log
              } else if (typeof frame.rawData === "string") {
                if (st.s === "assembling") {
                  expectedCloses.set(p, reject(p, 1002)); expectedWarns.push("collab_frame_malformed:text_during_reassembly");
                } else {
                  let header: unknown;
                  try { header = JSON.parse(frame.text()); } catch { header = undefined; }
                  const h = header as { type?: unknown; bytes?: unknown } | undefined;
                  const ok = typeof h === "object" && h !== null && !Array.isArray(h) && h.type === "chunked"
                    && typeof h.bytes === "number" && Number.isInteger(h.bytes) && h.bytes > F;
                  if (!ok) {
                    expectedCloses.set(p, reject(p, 1002)); expectedWarns.push("collab_frame_malformed:bad_header");
                  } else {
                    const bytes = h.bytes as number;
                    const k = keyOf(p);
                    if (bytes > lim.M) {
                      expectedCloses.set(p, reject(p, 1009)); expectedWarns.push("collab_message_too_large:declared");
                    } else if ((userIn.get(k) ?? 0) + bytes > lim.M) {
                      expectedCloses.set(p, reject(p, 1013)); expectedWarns.push("collab_reassembly_budget_exhausted:user");
                    } else if (inUse + bytes > lim.B) {
                      expectedCloses.set(p, reject(p, 1013)); expectedWarns.push("collab_reassembly_budget_exhausted:process");
                    } else {
                      inUse += bytes;
                      userIn.set(k, (userIn.get(k) ?? 0) + bytes);
                      model.set(p, { s: "assembling", bytes, received: 0, chunks: [], deadline: now + lim.T });
                    }
                  }
                }
              } else {
                const data = frame.uint8Array();
                if (st.s === "idle") {
                  expectedReturn = data;
                } else {
                  const after = st.received + data.byteLength;
                  if (after > lim.M) {
                    expectedCloses.set(p, reject(p, 1009)); expectedWarns.push("collab_message_too_large:received");
                  } else if (after > st.bytes) {
                    expectedCloses.set(p, reject(p, 1002)); expectedWarns.push("collab_frame_malformed:overflow");
                  } else if (after < st.bytes && data.byteLength < F) {
                    expectedCloses.set(p, reject(p, 1002)); expectedWarns.push("collab_frame_malformed:short_chunk");
                  } else {
                    st.chunks.push(data);
                    st.received = after;
                    st.deadline = now + lim.T;
                    if (after === st.bytes) {
                      expectedReturn = Buffer.concat(st.chunks);
                      release(p);
                      model.set(p, { s: "idle" });
                    }
                  }
                }
              }
              const got = r.rx(p, frame);
              if (expectedReturn === undefined) expect(got).toBeUndefined();
              else expect(same(got, expectedReturn)).toBe(true);
            }
          }

          peers.forEach((p, i) => {
            const fresh = p.close.mock.calls.slice(closesBefore[i]);
            const code = expectedCloses.get(p);
            if (code === undefined) expect(fresh).toHaveLength(0);
            else expect(fresh).toEqual([[code, CLOSE[code]]]);
          });
          const warned = (logs.warn.mock.calls.slice(warnBefore) as Array<[{ ctx: Record<string, unknown> }, string]>)
            .map(([arg, event]) => `${event}:${String(arg.ctx.reason ?? arg.ctx.scope ?? arg.ctx.source ?? "")}`);
          expect(warned.sort()).toEqual(expectedWarns.sort());
          expect(logs.error.mock.calls.length - errorBefore).toBe(expectedError);
          expect(r.a.inUseBytes()).toBe(inUse);
          expect(r.a.inUseBytes()).toBeGreaterThanOrEqual(0);
          expect(r.a.inUseBytes()).toBeLessThanOrEqual(lim.B);
          expect(new Map(r.a.userInUse())).toEqual(userIn);
          const values = [...r.a.userInUse().values()];
          expect(values.every((v) => v > 0 && v <= lim.M)).toBe(true);
          expect(values.reduce((a, b) => a + b, 0)).toBe(r.a.inUseBytes());
        }
      }),
      { numRuns: 300 },
    );
  });

  it("AP02 any message reassembles to itself through the shared sender", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 * F }), fc.integer(), (n, seed) => {
        vi.clearAllMocks();
        const r = asm();
        const p = r.own("u");
        const m = msg(n, seed);
        const out = n <= F ? [r.rx(p, bin(m))] : feed(r, p, frames(m));
        const produced = out.filter((x) => x !== undefined);
        expect(produced).toHaveLength(1);
        expect(same(out.at(-1), m)).toBe(true);
        expect(r.a.inUseBytes()).toBe(0);
        expect(r.a.userInUse().size).toBe(0);
        expect(p.close).not.toHaveBeenCalled();
      }),
      { numRuns: 200 },
    );
  });
});
