// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The inbound frame filter that sits after chunk reassembly (inner#1790,
 * design 4.4, v2 collab test spec section 9: F-01 to F-09; F-07 through the
 * production peer hooks lives in `src/__tests__/inbound-filter-hooks.test.ts`).
 *
 * Per `(socketId, documentName)` it keeps a handshake mark (a SyncStep2 frame
 * of that document passed) and a refusal mark (the size cap refused an update
 * of that document). Frames
 * are judged from their own bytes only. "Passes" means `filter` returns the
 * input bytes unchanged; "dropped" means it returns undefined. No case may
 * close the socket. `isRefused` is the query `beforeSync` step 0 reads the
 * refusal mark through (spec Q3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FilterModuleShape from "@collab/infra/inbound-filter.js";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import {
  SYNC,
  WIRE,
  authFrame,
  awarenessFrame,
  statelessFrame,
  syncFrame,
} from "@collab/__tests__/helpers/live-hocuspocus.js";

type FilterModule = typeof FilterModuleShape;

const D = "project-p1/canvas-s1";
const E = "project-p1/document-s2";

/** A crossws peer as the filter sees it. */
interface FakePeer {
  _hocuspocus: { socketId: string };
  close: ReturnType<typeof vi.fn>;
}

let mod: FilterModule;
let peers: FakePeer[] = [];

beforeEach(async () => {
  // The filter keeps its marks in module state; every case starts clean.
  vi.resetModules();
  mod = await import("@collab/infra/inbound-filter.js");
  peers = [];
});

afterEach(() => {
  for (const p of peers) expect(p.close).not.toHaveBeenCalled();
});

/**
 * A peer on its own socket.
 * @param socketId - The Hocuspocus socket id.
 * @returns The peer.
 */
function peer(socketId: string): FakePeer {
  const p = { _hocuspocus: { socketId }, close: vi.fn() };
  peers.push(p);
  return p;
}

/**
 * Call the filter under test with a fake peer.
 * @param p - The peer.
 * @param whole - The reassembled message.
 * @returns What the filter hands on.
 */
function run(p: unknown, whole: Uint8Array): Uint8Array | undefined {
  return (mod.filter as (peer: unknown, frame: Uint8Array) => Uint8Array | undefined)(p, whole);
}

/**
 * A real Yjs update, the payload of every Update frame here.
 * @returns The update bytes.
 */
function realUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 7;
  doc.getText("t").insert(0, "hello");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

const UPDATE = realUpdate();
const EMPTY_STEP2 = Uint8Array.of(0, 0);

const frames = {
  auth: (name: string): Uint8Array => authFrame(name, "__cookie_auth__"),
  step1: (name: string): Uint8Array => syncFrame(name, WIRE.sync, SYNC.step1, Uint8Array.of(0)),
  step2: (name: string, outer: number = WIRE.sync): Uint8Array => syncFrame(name, outer, SYNC.step2, EMPTY_STEP2),
  update: (name: string, outer: number = WIRE.sync): Uint8Array => syncFrame(name, outer, SYNC.update, UPDATE),
  awareness: (name: string): Uint8Array => awarenessFrame(name, Uint8Array.of(0)),
  stateless: (name: string): Uint8Array => statelessFrame(name, "{}"),
  close: (name: string): Uint8Array => bare(name, WIRE.close),
  queryAwareness: (name: string): Uint8Array => bare(name, WIRE.queryAwareness),
};

/**
 * A frame that is a document name and an outer type only.
 * @param name - The message key.
 * @param type - The outer message type.
 * @returns The frame.
 */
function bare(name: string, type: number): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, type);
  return encoding.toUint8Array(encoder);
}

/**
 * Assert the filter hands the frame on byte for byte.
 * @param p - The peer.
 * @param frame - The frame.
 * @param label - Names the frame in a failure.
 */
function passes(p: FakePeer, frame: Uint8Array, label: string): void {
  const out = run(p, frame);
  expect(out, label).toBeInstanceOf(Uint8Array);
  expect(Array.from(out ?? []), label).toEqual(Array.from(frame));
}

/**
 * Assert the filter drops the frame.
 * @param p - The peer.
 * @param frame - The frame.
 * @param label - Names the frame in a failure.
 */
function drops(p: FakePeer, frame: Uint8Array, label: string): void {
  expect(run(p, frame), label).toBeUndefined();
}

/** The three states of one (socket, document) pair. */
type State = "W" | "H" | "R";

/**
 * Bring a fresh socket's `D` into a state.
 * @param socketId - The socket.
 * @param state - Waiting for the handshake, handshaken, or refused.
 * @param name - The document, `D` unless given.
 * @returns The peer.
 */
function inState(socketId: string, state: State, name = D): FakePeer {
  const p = peer(socketId);
  if (state === "W") return p;
  passes(p, frames.auth(name), "auth while building state");
  passes(p, frames.step2(name), "step2 while building state");
  if (state === "R") mod.markRefused(socketId, name);
  return p;
}

const STATES: State[] = ["W", "H", "R"];

describe("inbound filter", () => {
  it("F-03 passes Auth in every state and puts the document back to waiting for the handshake", () => {
    for (const state of STATES) {
      const p = inState(`s-${state}`, state);
      passes(p, frames.auth(D), `${state}: auth`);
      drops(p, frames.update(D), `${state}: update after auth`);
      passes(p, frames.step2(D), `${state}: step2 after auth`);
    }
  });

  it("F-04 drops every frame of a refused document, whatever its type, until the next Auth", () => {
    for (const from of ["W", "H"] as const) {
      const p = inState(`s-${from}`, from);
      mod.markRefused(`s-${from}`, D);
      drops(p, frames.step2(D, WIRE.sync), `${from}→R: step2 outer 0`);
      drops(p, frames.step2(D, WIRE.syncReply), `${from}→R: step2 outer 4`);
      drops(p, frames.update(D, WIRE.sync), `${from}→R: update outer 0`);
      drops(p, frames.update(D, WIRE.syncReply), `${from}→R: update outer 4`);
      drops(p, frames.step1(D), `${from}→R: step1`);
      drops(p, frames.awareness(D), `${from}→R: awareness`);
      drops(p, frames.stateless(D), `${from}→R: stateless`);
      drops(p, frames.close(D), `${from}→R: close`);
      drops(p, frames.queryAwareness(D), `${from}→R: query awareness`);
      passes(p, frames.auth(D), `${from}→R: auth`);
      passes(p, frames.step2(D), `${from}→R: step2 after auth`);
    }
  });

  it("F-02 passes SyncStep2 under either outer type and lets the Updates after it through", () => {
    const a = peer("s1");
    passes(a, frames.step2(D, WIRE.sync), "W: step2 outer 0");
    passes(a, frames.update(D, WIRE.sync), "update after step2 outer 0");
    const b = peer("s2");
    passes(b, frames.step2(D, WIRE.syncReply), "W: step2 outer 4");
    passes(b, frames.update(D, WIRE.syncReply), "update after step2 outer 4");
    const h = inState("s3", "H");
    passes(h, frames.step2(D), "H: step2 again");
  });

  it("F-01 drops an Update that arrives before the handshake SyncStep2, without closing", () => {
    drops(peer("s1"), frames.update(D, WIRE.sync), "W: update outer 0");
    drops(peer("s2"), frames.update(D, WIRE.syncReply), "W: update outer 4");
    const c = peer("s3");
    passes(c, frames.auth(D), "auth");
    drops(c, frames.update(D), "update after auth, before step2");
  });

  it("F-02 passes every Update after the handshake under either outer type", () => {
    const p = inState("s1", "H");
    for (let i = 0; i < 3; i++) {
      passes(p, frames.update(D, WIRE.sync), `H: update outer 0 #${i}`);
      passes(p, frames.update(D, WIRE.syncReply), `H: update outer 4 #${i}`);
    }
  });

  it("F-05 passes SyncStep1, awareness, stateless, CLOSE and QueryAwareness while waiting or handshaken", () => {
    for (const state of ["W", "H"] as const) {
      const p = inState(`s-${state}`, state);
      passes(p, frames.step1(D), `${state}: step1`);
      passes(p, frames.awareness(D), `${state}: awareness`);
      passes(p, frames.stateless(D), `${state}: stateless`);
      passes(p, frames.close(D), `${state}: close`);
      passes(p, frames.queryAwareness(D), `${state}: query awareness`);
    }
  });

  it("F-06 keeps marks per socket and per document", () => {
    const s1 = inState("s1", "R");
    passes(s1, frames.auth(E), "s1: auth E");
    passes(s1, frames.step2(E), "s1: step2 E");
    const s2 = inState("s2", "H");
    passes(s1, frames.update(E), "s1: update E (E handshaken)");
    passes(s2, frames.update(D), "s2: update D (D handshaken on s2)");
    drops(s1, frames.update(D), "s1: update D (D refused on s1)");
  });

  it("F-01 decides from the frame alone, reading nothing but the socket id and closing nothing", () => {
    const touched = new Set<PropertyKey>();
    const close = vi.fn();
    const hocuspocus = new Proxy({ socketId: "s1" }, {
      get(target, key, receiver): unknown {
        touched.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const proxied = new Proxy({ _hocuspocus: hocuspocus, close }, {
      get(target, key, receiver): unknown {
        touched.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(run(proxied, frames.update(D))).toBeUndefined();
    expect([...touched].filter((key) => key !== "_hocuspocus" && key !== "socketId")).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it("F-09 passes frames it cannot decode unchanged and leaves the marks as they were", () => {
    const docOnly = encoding.createEncoder();
    encoding.writeVarString(docOnly, D);
    const syncNoSub = bare(D, WIRE.sync);
    const broken = [
      new Uint8Array(0),
      encoding.toUint8Array(docOnly),
      syncNoSub,
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    ];
    for (const state of STATES) {
      const p = inState(`s-${state}`, state);
      for (const [i, frame] of broken.entries()) {
        let out: Uint8Array | undefined;
        expect(() => {
          out = run(p, frame);
        }, `${state}: broken frame ${i}`).not.toThrow();
        expect(out, `${state}: broken frame ${i}`).toBeInstanceOf(Uint8Array);
        expect(Array.from(out ?? []), `${state}: broken frame ${i}`).toEqual(Array.from(frame));
      }
      if (state === "H") passes(p, frames.update(D), "H: update after broken frames");
      else drops(p, frames.update(D), `${state}: update after broken frames`);
    }
  });

  it("F-08 keys the marks by the name before the first \\0, as Hocuspocus does", () => {
    const sess1 = `${D}\0sess-1`;
    const sess2 = `${D}\0sess-2`;
    const D2 = `${D}x`;
    const p = peer("s1");
    // (d) set-up: D2 handshaken on the same socket before anything happens to D.
    passes(p, frames.auth(D2), "auth D2");
    passes(p, frames.step2(D2), "step2 D2");

    // (a) a handshake under one session key covers the bare name and every other key.
    passes(p, frames.step2(sess1), "(a) step2 D\\0sess-1");
    passes(p, frames.update(D), "(a) update D");
    passes(p, frames.update(sess2), "(a) update D\\0sess-2");

    // (b) a refusal of the bare name covers every session key.
    mod.markRefused("s1", D);
    drops(p, frames.update(sess1), "(b) update D\\0sess-1");
    drops(p, frames.step2(sess1), "(b) step2 D\\0sess-1");
    drops(p, frames.awareness(sess1), "(b) awareness D\\0sess-1");

    // (d) D2 is another document.
    passes(p, frames.update(D2), "(d) update D2 while D is refused");

    // (c) an Auth under any session key clears both marks of D.
    passes(p, frames.auth(sess2), "(c) auth D\\0sess-2");
    drops(p, frames.update(D), "(c) update D after auth");
    passes(p, frames.step2(D), "(c) step2 D after auth");

    // (d) and D's marks do not reach a fresh D2 either.
    const q = peer("s2");
    passes(q, frames.step2(D), "(d) step2 D on s2");
    drops(q, frames.update(D2), "(d) update D2 on s2, never handshaken");
  });

  it("F-04 isRefused is true once markRefused ran and false again after an Auth frame of that document", () => {
    const p = inState("s1", "H");
    expect(mod.isRefused("s1", D), "handshaken, never refused").toBe(false);
    mod.markRefused("s1", D);
    expect(mod.isRefused("s1", D), "after markRefused").toBe(true);
    drops(p, frames.update(D), "update while refused");
    expect(mod.isRefused("s1", D), "a dropped frame keeps the mark").toBe(true);
    passes(p, frames.auth(D), "auth");
    expect(mod.isRefused("s1", D), "after auth").toBe(false);
    expect(mod.isRefused("s-never", D), "a socket the filter never saw").toBe(false);
  });

  it("F-06 isRefused answers per (socket, document): another document or another socket is not refused", () => {
    inState("s1", "R");
    inState("s2", "H");
    inState("s1-e", "H", E);
    expect(mod.isRefused("s1", D)).toBe(true);
    expect(mod.isRefused("s1", E), "same socket, another document").toBe(false);
    expect(mod.isRefused("s2", D), "same document, another socket").toBe(false);
    mod.markRefused("s3", E);
    expect(mod.isRefused("s3", E), "refused without any frame seen").toBe(true);
    expect(mod.isRefused("s3", D)).toBe(false);
  });

  it("F-07 forgetSocket clears the socket's refusal: isRefused turns false and the document waits for a handshake", () => {
    const p = inState("s1", "R");
    inState("s2", "R");
    mod.forgetSocket(p);
    expect(mod.isRefused("s1", D), "forgotten socket").toBe(false);
    expect(mod.isRefused("s2", D), "another socket keeps its mark").toBe(true);
    drops(p, frames.update(D), "update with no mark left (waiting)");
    passes(p, frames.step2(D), "step2 once the refusal is gone");
    passes(p, frames.update(D), "update after the new handshake");
  });
});
