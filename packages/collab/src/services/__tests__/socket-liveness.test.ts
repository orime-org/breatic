// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One pong, two facts.
 *
 * Both of these already have their own tests, and both of those pass when the
 * pong never reaches them — they call the functions directly. What is asserted
 * here is only the wiring, which is what actually went missing: presence spent
 * a whole change unconnected to the pong while its expiry was cut to two ping
 * periods, and every test in the package stayed green.
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import { readPresence } from "@collab/hooks/presence.js";
import { createPongHandler } from "@collab/services/socket-liveness.js";

const PID = "11111111-1111-4111-8111-111111111111";
const META_DOC = `project-${PID}/meta`;
const ALICE = "u-alice";

/**
 * A meta document holding one online record.
 * @param lastSeenAt - When that record was last refreshed.
 * @returns The document.
 */
function metaDocWith(lastSeenAt: number): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    doc.getMap("users").set(ALICE, entry);
    entry.set("id", ALICE);
    entry.set("online", true);
    entry.set("lastSeenAt", lastSeenAt);
  });
  return doc;
}

describe("a pong refreshes everything it proves", () => {
  it("moves the socket's seats forward", () => {
    const refreshSeats = vi.fn(async () => undefined);
    const handler = createPongHandler({
      refreshSeats,
      presencePolicy: { now: () => 1_000, staleAfterMs: 60_000 },
    });

    handler("sock-1", new Map());

    expect(refreshSeats).toHaveBeenCalledWith("sock-1");
  });

  it("moves the owner of the socket's meta connection forward", () => {
    const doc = metaDocWith(1_000);
    const handler = createPongHandler({
      refreshSeats: vi.fn(async () => undefined),
      presencePolicy: { now: () => 31_000, staleAfterMs: 60_000 },
    });

    handler(
      "sock-1",
      new Map([
        [META_DOC, { context: { user: { id: ALICE } }, document: doc }],
      ]),
    );

    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(31_000);
    doc.destroy();
  });

  it("does both from one pong, not one or the other", () => {
    // The two are independent calls, so a change that keeps one can drop the
    // other and leave both of their own suites green. This is the only case
    // that reads them together.
    const refreshSeats = vi.fn(async () => undefined);
    const doc = metaDocWith(1_000);
    const handler = createPongHandler({
      refreshSeats,
      presencePolicy: { now: () => 31_000, staleAfterMs: 60_000 },
    });

    handler(
      "sock-1",
      new Map([
        [META_DOC, { context: { user: { id: ALICE } }, document: doc }],
      ]),
    );

    expect(refreshSeats).toHaveBeenCalledTimes(1);
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(31_000);
    doc.destroy();
  });
});
