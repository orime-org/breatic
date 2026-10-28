// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Chunked collab messages through real upgrades (inner#1585): a real
 * `Server` with the production session gate on a real Redis session, the
 * reassembler keyed by the gate's `userOf`, and the pino log file. Large
 * pastes and offline catch-ups arrive whole; every limit closes the
 * connection with its code and leaves one structured log line.
 */

import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";
import {
  createRedisClient,
  env,
  initCore,
  initLogger,
  sessionCookieName,
  setSession,
  type Redis,
} from "@breatic/core";
import { COLLAB_FRAME_MAX_BYTES, sendInChunks } from "@breatic/shared";
import { createFrameAssembler, type FramePeer } from "@collab/infra/frame-assembler.js";
import { createUpgradeSessionGate } from "@collab/infra/upgrade-session-gate.js";
import { SOCKET_CEILINGS } from "@collab/infra/socket-ceilings.js";
import { SYNC, WIRE, authFrame, decodeServerFrame, statelessFrameOfSize, syncFrame, waitFor } from "../../__tests__/helpers/live-hocuspocus.js";

const F = COLLAB_FRAME_MAX_BYTES;
const M = 10_551_296;
const B = 67_108_864;
const CLOSE = {
  1009: "message too large",
  1013: "reassembly budget exhausted",
  1002: "malformed frame",
  1008: "reassembly idle timeout",
} as const;

const logsRoot = mkdtempSync(join(tmpdir(), "frame-assembler-logs-"));
const stacks: Array<{ server: Server; gate: ReturnType<typeof createUpgradeSessionGate> }> = [];
const clients: WebSocket[] = [];
const rawSockets: Socket[] = [];
const redisClients: Redis[] = [];
const keys: Array<{ redis: Redis; key: string }> = [];

beforeAll(() => {
  initCore(process.env);
  initLogger("frame-assembler-test", { logsRoot, debug: true, console: "none" });
});

afterAll(() => {
  rmSync(logsRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const s of rawSockets.splice(0)) s.destroy();
  for (const s of stacks.splice(0)) {
    s.gate.stop();
    await s.server.destroy();
  }
  await Promise.allSettled(keys.splice(0).map(({ redis, key }) => redis.del(key)));
  for (const r of redisClients.splice(0)) r.disconnect();
});

/** One pino line. */
interface LogLine { level: number; msg: string; ctx?: Record<string, unknown>; err?: { message?: string } }

/**
 * Every line the test logger wrote so far.
 * @returns Parsed lines.
 */
function logLines(): LogLine[] {
  const dir = join(logsRoot, "frame-assembler-test");
  return readdirSync(dir)
    .flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogLine);
}

/**
 * The reassembly log lines of one user.
 * @param userId - The user.
 * @returns Lines whose ctx names that user.
 */
function linesOf(userId: string): LogLine[] {
  return logLines().filter((l) => l.msg.startsWith("collab_") && l.ctx?.userId === userId);
}

/** A running stack and what its hooks observed. */
interface Stack {
  port: number;
  server: Server;
  asm: ReturnType<typeof createFrameAssembler>;
  redis: Redis;
  connected: string[];
  stateless: string[];
  changes: string[];
  hookOrder: Array<{ hook: "error" | "close"; inUseAfter: number }>;
  erroredPeers: FramePeer[];
}

/**
 * Start a real server with the production gate and the reassembler.
 * @param opts - Reassembler limits.
 * @returns The stack.
 */
async function stack(opts: Partial<{ maxMessageBytes: number; budgetBytes: number; idleTimeoutMs: number; serverTimeoutMs: number }> = {}): Promise<Stack> {
  const redis = createRedisClient(inject("REDIS_URL"), { name: "frame-assembler-integration", keyPrefix: `fa-${randomUUID()}:` });
  redisClients.push(redis);
  await redis.ping();
  const gate = createUpgradeSessionGate({ redis });
  const asm = createFrameAssembler({
    maxMessageBytes: opts.maxMessageBytes ?? M,
    budgetBytes: opts.budgetBytes ?? B,
    idleTimeoutMs: opts.idleTimeoutMs ?? 30_000,
    userOf: gate.userOf,
  });
  const s: Partial<Stack> = { asm, redis, connected: [], stateless: [], changes: [], hookOrder: [], erroredPeers: [] };
  const server = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    stopOnSignals: false,
    timeout: opts.serverTimeoutMs ?? 60_000,
    ...SOCKET_CEILINGS,
    websocketOptions: { maxPayload: F },
    receiveFrame: asm.receiveFrame,
    onPeerClose: (peer: FramePeer, event: unknown) => { asm.onPeerClose(peer, event); s.hookOrder!.push({ hook: "close", inUseAfter: asm.inUseBytes() }); },
    onPeerError: (peer: FramePeer, error: unknown) => {
      s.erroredPeers!.push(peer);
      asm.onPeerError(peer, error);
      s.hookOrder!.push({ hook: "error", inUseAfter: asm.inUseBytes() });
    },
    extensions: [gate],
    onAuthenticate: async () => ({ user: { id: "member" } }),
    connected: async ({ documentName }: { documentName: string }) => { s.connected!.push(documentName); },
    onStateless: async ({ payload }: { payload: string }) => { s.stateless!.push(payload); },
    onChange: async ({ documentName }: { documentName: string }) => { s.changes!.push(documentName); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await server.listen();
  stacks.push({ server, gate });
  return Object.assign(s, { server, port: server.address.port }) as Stack;
}

/**
 * Save a real session for a user.
 * @param st - Stack.
 * @param userId - User.
 * @returns The Cookie header.
 */
async function sess(st: Stack, userId: string): Promise<string> {
  const token = `fa-${randomUUID()}`;
  await setSession(st.redis, token, userId);
  keys.push({ redis: st.redis, key: `${env.ENV}:session:${token}` });
  return `${sessionCookieName()}=${token}`;
}

/** A ws client and the close it receives. */
interface Client { ws: WebSocket; closed: Promise<{ code: number; reason: string }>; isOpen: () => boolean }

/**
 * Open a ws client with a cookie.
 * @param st - Stack.
 * @param cookie - Cookie header.
 * @returns The open client.
 */
async function client(st: Stack, cookie: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${st.port}/`, { headers: { cookie } });
  clients.push(ws);
  ws.on("error", () => {});
  let open = true;
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once("close", (code, reason) => { open = false; resolve({ code, reason: reason.toString() }); }));
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, closed, isOpen: () => open };
}

/**
 * Authenticate a document on a client.
 * @param st - Stack.
 * @param c - Client.
 * @param doc - Document.
 */
async function auth(st: Stack, c: Client, doc: string): Promise<void> {
  const before = st.connected.filter((d) => d === doc).length;
  c.ws.send(authFrame(doc, "t"));
  await waitFor(() => st.connected.filter((d) => d === doc).length > before, `auth ${doc}`);
}

/**
 * Write a whole message the way the browser does, in one synchronous call.
 * @param c - Client.
 * @param bytes - Message.
 */
function sendChunked(c: Client, bytes: Uint8Array): void {
  sendInChunks(bytes, (f) => c.ws.send(f));
}

/**
 * A sync frame carrying a fresh document's text.
 * @param doc - Document.
 * @param text - Text inserted at 0 in `t`.
 * @param sub - `SYNC.update` or `SYNC.step2`.
 * @returns The frame.
 */
function upd(doc: string, text: string, sub: number): Uint8Array {
  const d = new Y.Doc();
  d.getText("t").insert(0, text);
  return syncFrame(doc, WIRE.sync, sub, Y.encodeStateAsUpdate(d));
}

/**
 * A declaration text frame.
 * @param n - Declared bytes.
 * @returns The JSON text.
 */
function decl(n: number): string {
  return JSON.stringify({ type: "chunked", bytes: n });
}

/**
 * A second member reading a document: applies every update the server sends
 * and counts the ones that arrive after it has joined.
 * @param st - Stack.
 * @param cookie - Cookie header.
 * @param doc - Document.
 * @returns Its Y.Doc and the count of updates applied since joining.
 */
async function watcher(st: Stack, cookie: string, doc: string): Promise<{ ydoc: Y.Doc; updates: () => number }> {
  const ydoc = new Y.Doc();
  const c = await client(st, cookie);
  c.ws.on("message", (data: Buffer) => {
    const frame = decodeServerFrame(new Uint8Array(data));
    if (frame.docName === doc && frame.update) Y.applyUpdate(ydoc, frame.update);
  });
  await auth(st, c, doc);
  await settle();
  let count = 0;
  ydoc.on("update", () => { count += 1; });
  return { ydoc, updates: () => count };
}

/**
 * Write a masked client frame by hand.
 * @param payload - Bytes or text.
 * @returns The frame.
 */
function clientFrame(payload: Uint8Array | string): Buffer {
  const text = typeof payload === "string";
  const data = Buffer.from(payload);
  const mask = randomBytes(4);
  const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]!));
  let head: Buffer;
  if (data.length < 126) head = Buffer.from([text ? 0x81 : 0x82, 0x80 | data.length]);
  else if (data.length < 65_536) head = Buffer.from([text ? 0x81 : 0x82, 0x80 | 126, data.length >> 8, data.length & 0xff]);
  else {
    head = Buffer.alloc(10);
    head[0] = text ? 0x81 : 0x82;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, mask, masked]);
}

/**
 * Upgrade by hand; this client never answers a close frame.
 * @param st - Stack.
 * @param cookie - Cookie header.
 * @returns The socket and the close code it has read so far.
 */
function raw(st: Stack, cookie: string): Promise<{ socket: Socket; closeCode: () => number | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: st.port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Cookie: cookie,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    req.on("upgrade", (_res, socket: Socket) => {
      rawSockets.push(socket);
      let buffered = Buffer.alloc(0);
      let code: number | undefined;
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const at = buffered.indexOf(0x88);
        if (at >= 0 && buffered.length >= at + 4) code = buffered.readUInt16BE(at + 2);
      });
      resolve({ socket, closeCode: () => code });
    });
    req.on("response", (res) => reject(new Error(`status ${res.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Wait a little to see that nothing else happens.
 * @param ms - Milliseconds.
 */
async function settle(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("frame reassembly through real upgrades", () => {
  const LARGE = "<svg onload=1>&" + "中".repeat(400_000);

  it("I01 a 1.2 MB paste arrives as one update for everyone", async () => {
    const st = await stack();
    const a = await client(st, await sess(st, "ua-i01"));
    await auth(st, a, "i01");
    const b = await watcher(st, await sess(st, "ub-i01"), "i01");
    sendChunked(a, upd("i01", LARGE, SYNC.update));
    await waitFor(() => b.ydoc.getText("t").toString() === LARGE, "b sees the paste", 20_000);
    expect(st.server.hocuspocus.documents.get("i01")?.getText("t").toString()).toBe(LARGE);
    expect(st.changes.filter((d) => d === "i01")).toHaveLength(1);
    expect(b.updates()).toBe(1);
    expect(a.isOpen()).toBe(true);
    expect(st.asm.inUseBytes()).toBe(0);
    expect(st.asm.userInUse().size).toBe(0);
    expect(linesOf("ua-i01").filter((l) => l.level >= 40)).toHaveLength(0);
  });

  it("I01b a 3 MiB offline catch-up arrives whole", async () => {
    const st = await stack();
    const a = await client(st, await sess(st, "ua-i01b"));
    await auth(st, a, "i01b");
    const b = await watcher(st, await sess(st, "ub-i01b"), "i01b");
    const text = "中".repeat(1_048_576);
    sendChunked(a, upd("i01b", text, SYNC.step2));
    await waitFor(() => b.ydoc.getText("t").toString() === text, "b sees the catch-up", 30_000);
    expect(st.server.hocuspocus.documents.get("i01b")?.getText("t").toString()).toBe(text);
    expect(b.updates()).toBe(1);
    expect(st.asm.inUseBytes()).toBe(0);
  });

  it("I02 a frame at the cap passes; one byte over closes 1009 before authentication and is logged", async () => {
    const st = await stack();
    const a = await client(st, await sess(st, "ua-i02"));
    await auth(st, a, "i02");
    a.ws.send(statelessFrameOfSize("i02", F));
    await waitFor(() => st.stateless.length === 1, "frame at the cap");
    expect(a.isOpen()).toBe(true);

    const c = await client(st, await sess(st, "uc-i02"));
    c.ws.send(new Uint8Array(F + 1));
    expect((await c.closed).code).toBe(1009);
    await waitFor(() => linesOf("uc-i02").length === 1, "too-large log");
    const [line] = linesOf("uc-i02");
    expect(line!.msg).toBe("collab_frame_too_large");
    expect(line!.ctx).toMatchObject({ limit: F, userId: "uc-i02" });
    expect(line!.err?.message).toContain("Max payload size exceeded");
    expect(line!.ctx?.socketId).toBe(st.erroredPeers.at(-1)?._hocuspocus?.socketId);
    expect(typeof line!.ctx?.socketId).toBe("string");
    expect(String(line!.ctx?.remoteAddress)).toMatch(/127\.0\.0\.1$/);
    expect(logLines().some((l) => l.msg === "collab_socket_error" && l.ctx?.userId === "uc-i02")).toBe(false);
    expect(st.stateless).toHaveLength(1);
  });

  it("I03 a declaration over the cap closes 1009 and the chunks already sent are dropped", async () => {
    const st = await stack();
    const a = await client(st, await sess(st, "ua-i03"));
    await auth(st, a, "i03");
    a.ws.send(decl(M + 1));
    for (let i = 0; i < 5; i++) a.ws.send(statelessFrameOfSize("i03", F));
    expect(await a.closed).toEqual({ code: 1009, reason: CLOSE[1009] });
    await settle();
    const lines = linesOf("ua-i03");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe("collab_message_too_large");
    expect(lines[0]!.ctx).toMatchObject({ source: "declared", bytes: M + 1, limit: M });
    expect(st.stateless).toHaveLength(0);
    expect(st.asm.inUseBytes()).toBe(0);
  });

  it("I04 chunks that push the total past the cap close 1009", async () => {
    const st = await stack();
    const a = await client(st, await sess(st, "ua-i04"));
    a.ws.send(decl(M - 1));
    for (let i = 0; i < 80; i++) a.ws.send(new Uint8Array(F));
    a.ws.send(new Uint8Array(65_537));
    expect(await a.closed).toEqual({ code: 1009, reason: CLOSE[1009] });
    await waitFor(() => linesOf("ua-i04").length === 1, "log");
    expect(linesOf("ua-i04")[0]).toMatchObject({ msg: "collab_message_too_large", ctx: { source: "received", bytes: M + 1, limit: M } });
    expect(st.asm.inUseBytes()).toBe(0);
  });

  it("I05 the seventh account is refused at the process budget while the others finish", async () => {
    const st = await stack();
    const big = upd("i05", "a".repeat(5_000_000), SYNC.update);
    const L = big.byteLength;
    const holders = await Promise.all([1, 2, 3, 4, 5, 6].map(async (i) => client(st, await sess(st, `u${i}-i05`))));
    await auth(st, holders[0]!, "i05");
    holders[0]!.ws.send(decl(L));
    for (const h of holders.slice(1)) h.ws.send(decl(M));
    await waitFor(() => st.asm.inUseBytes() === 5 * M + L, "six reservations");
    const late = await client(st, await sess(st, "u7-i05"));
    late.ws.send(decl(M));
    expect(await late.closed).toEqual({ code: 1013, reason: CLOSE[1013] });
    await waitFor(() => linesOf("u7-i05").length === 1, "budget log");
    expect(linesOf("u7-i05")[0]).toMatchObject({
      msg: "collab_reassembly_budget_exhausted",
      ctx: { scope: "process", bytes: M, userInUseBytes: 0, inUseBytes: 5 * M + L, budgetBytes: B },
    });
    for (let o = 0; o < L; o += F) holders[0]!.ws.send(big.subarray(o, Math.min(o + F, L)));
    await waitFor(() => (st.server.hocuspocus.documents.get("i05")?.getText("t").length ?? 0) === 5_000_000, "u1 message applied", 20_000);
    expect(st.asm.inUseBytes()).toBe(5 * M);
    for (const h of holders) expect(h.isOpen()).toBe(true);
  });

  it("I06 one session's second connection is refused at the user's share; another session is not", async () => {
    const st = await stack();
    const cookieA = await sess(st, "ua-i06");
    const a1 = await client(st, cookieA);
    const a2 = await client(st, cookieA);
    const b = await client(st, await sess(st, "ub-i06"));
    await auth(st, a2, "i06");
    a1.ws.send(decl(M));
    await waitFor(() => st.asm.inUseBytes() === M, "a1 reserved");
    a2.ws.send(decl(M));
    for (let i = 0; i < 3; i++) a2.ws.send(statelessFrameOfSize("i06", F));
    expect(await a2.closed).toEqual({ code: 1013, reason: CLOSE[1013] });
    b.ws.send(decl(M));
    await waitFor(() => st.asm.inUseBytes() === 2 * M, "b reserved");
    await settle();
    expect(linesOf("ua-i06")).toHaveLength(1);
    expect(linesOf("ua-i06")[0]).toMatchObject({
      msg: "collab_reassembly_budget_exhausted",
      ctx: { scope: "user", userId: "ua-i06", bytes: M, userInUseBytes: M, inUseBytes: M, budgetBytes: B },
    });
    expect(st.stateless).toHaveLength(0);
    expect(a1.isOpen()).toBe(true);
    expect(b.isOpen()).toBe(true);
    expect(new Map(st.asm.userInUse())).toEqual(new Map([["ua-i06", M], ["ub-i06", M]]));
  });

  it.each([
    ["a", "bad_header"],
    ["b", "text_during_reassembly"],
    ["c", "short_chunk"],
  ])("I07 (%s) closes 1002 %s with its byte fields", async (row, reason) => {
    const st = await stack();
    const user = `ua-i07${row}`;
    const c = await client(st, await sess(st, user));
    await auth(st, c, `i07${row}`);
    if (row === "a") c.ws.send("hello");
    if (row === "b") {
      c.ws.send(decl(3 * F));
      c.ws.send(new Uint8Array(F));
      c.ws.send("hello");
      c.ws.send(statelessFrameOfSize(`i07${row}`, F));
      c.ws.send(statelessFrameOfSize(`i07${row}`, F));
    }
    if (row === "c") {
      c.ws.send(decl(3 * F));
      c.ws.send(new Uint8Array(F - 1));
    }
    expect(await c.closed).toEqual({ code: 1002, reason: CLOSE[1002] });
    await waitFor(() => linesOf(user).length === 1, "malformed log");
    const expected = {
      a: { reason, frameBytes: 5, bytes: null, receivedBytes: 0 },
      b: { reason, frameBytes: 5, bytes: 3 * F, receivedBytes: F },
      c: { reason, frameBytes: F - 1, bytes: 3 * F, receivedBytes: 0 },
    }[row as "a" | "b" | "c"];
    const line = linesOf(user)[0]!;
    expect(line.msg).toBe("collab_frame_malformed");
    expect(line.ctx).toMatchObject({ ...expected, userId: user });
    expect(typeof line.ctx?.socketId).toBe("string");
    expect(line.ctx).toHaveProperty("remoteAddress");
    expect(st.stateless).toHaveLength(0);
    expect(st.asm.inUseBytes()).toBe(0);
  });

  it("I08 an oversized frame mid-message returns the reservation in the error hook, before the close hook", async () => {
    const st = await stack({ idleTimeoutMs: 1_000 });
    const r = await raw(st, await sess(st, "ua-i08"));
    r.socket.write(clientFrame(authFrame("i08", "t")));
    await waitFor(() => st.connected.includes("i08"), "auth");
    r.socket.write(clientFrame(decl(1_048_576)));
    r.socket.write(clientFrame(new Uint8Array(F)));
    await waitFor(() => st.asm.inUseBytes() === 1_048_576, "reserved");
    r.socket.write(clientFrame(new Uint8Array(204_800)));
    await waitFor(() => linesOf("ua-i08").some((l) => l.msg === "collab_frame_too_large"), "too-large log");
    expect(st.asm.inUseBytes()).toBe(0);
    expect(st.asm.userInUse().size).toBe(0);
    // ws ends the socket right after its close frame once the receiver has
    // errored (ws.mjs:1606), so the close hook follows soon; the reservation
    // must already be back when the error hook returns, before the close.
    expect(st.hookOrder[0]).toEqual({ hook: "error", inUseAfter: 0 });
    await waitFor(() => r.closeCode() === 1009, "close frame 1009");
    await settle(2_000);
    expect(linesOf("ua-i08").some((l) => l.msg === "collab_reassembly_idle_timeout")).toBe(false);
  });

  it("I09 a client vanishing mid-message returns its reservation", async () => {
    const st = await stack();
    const a = await client(st, await sess(st, "ua-i09"));
    a.ws.send(decl(M));
    for (let i = 0; i < 3; i++) a.ws.send(new Uint8Array(F));
    await waitFor(() => st.asm.inUseBytes() === M, "reserved");
    a.ws.terminate();
    await waitFor(() => st.asm.inUseBytes() === 0, "released", 5_000);
    expect(st.asm.userInUse().size).toBe(0);
  });

  it("I11 a slow chunked message outlasting Hocuspocus's connection timeout still arrives", async () => {
    // Every chunk shows the peer is alive; only the reassembly idle timer bounds a stall.
    const st = await stack({ serverTimeoutMs: 1_000 });
    const a = await client(st, await sess(st, "ua-i11"));
    await auth(st, a, "i11");
    const frame = upd("i11", "x".repeat(2_000_000), SYNC.update);
    a.ws.send(decl(frame.byteLength));
    for (let o = 0; o < frame.byteLength; o += F) {
      await settle(400);
      a.ws.send(frame.subarray(o, Math.min(o + F, frame.byteLength)));
    }
    expect(a.isOpen()).toBe(true);
    await waitFor(() => (st.server.hocuspocus.documents.get("i11")?.getText("t").length ?? 0) === 2_000_000, "slow message applied", 15_000);
    expect(st.asm.inUseBytes()).toBe(0);
  });

  it("I12 the uploader hears back after the declaration and every chunk but the last", async () => {
    // A busy uplink holds back the browser's pongs and awareness, so these
    // acknowledgements are all it receives while the message is in flight.
    const st = await stack();
    const a = await client(st, await sess(st, "ua-i12"));
    await auth(st, a, "i12");
    let acks = 0;
    a.ws.on("message", (data: Buffer) => { if (data.byteLength === 1 && data[0] === 0) acks++; });
    const frame = upd("i12", "y".repeat(300_000), SYNC.update);
    const frames: Array<string | Uint8Array> = [];
    sendInChunks(frame, (f) => frames.push(f));
    expect(frames).toHaveLength(4);
    for (const [i, f] of frames.entries()) {
      a.ws.send(f);
      if (i < frames.length - 1) await waitFor(() => acks === i + 1, `ack ${i + 1}`);
    }
    await waitFor(() => (st.server.hocuspocus.documents.get("i12")?.getText("t").length ?? 0) === 300_000, "message applied");
    await settle();
    expect(acks).toBe(3);
  });

  it("I10 a stalled message times out with 1008 over a real connection", async () => {
    const st = await stack({ idleTimeoutMs: 1_000 });
    const a = await client(st, await sess(st, "ua-i10"));
    a.ws.send(decl(3 * F));
    a.ws.send(new Uint8Array(F));
    expect(await a.closed).toEqual({ code: 1008, reason: CLOSE[1008] });
    await waitFor(() => linesOf("ua-i10").length === 1, "idle log");
    expect(linesOf("ua-i10")[0]).toMatchObject({
      msg: "collab_reassembly_idle_timeout",
      ctx: { receivedBytes: F, bytes: 3 * F, userId: "ua-i10" },
    });
    expect(st.asm.inUseBytes()).toBe(0);
  });
});
