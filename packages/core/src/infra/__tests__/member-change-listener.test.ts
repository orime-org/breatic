// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The member-change listener's liveness probe (inner#911).
 *
 * The probe answers whether the listen connection receives notifications right
 * now, so it is true only when the nonce it sent comes back. The pool here
 * either delivers what is notified to the registered listeners or drops it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bus = vi.hoisted(() => ({
  listeners: new Map<string, (payload: string) => void>(),
  deliver: true,
}));
vi.mock("@core/db/client.js", () => ({
  rawPg: {
    listen: async (channel: string, fn: (payload: string) => void, onlisten?: () => void) => {
      bus.listeners.set(channel, fn);
      onlisten?.();
      return { unlisten: async () => undefined };
    },
    notify: async (channel: string, payload: string) => {
      if (bus.deliver) bus.listeners.get(channel)?.(payload);
      return [];
    },
  },
}));

import { listenProjectMemberChanges } from "@core/infra/member-change-listener.js";

const handlers = { onChange: vi.fn(), onListening: vi.fn(), onInvalid: vi.fn() };

describe("member change listener probe", () => {
  beforeEach(() => {
    bus.listeners.clear();
  });

  it("answers true when the nonce comes back", async () => {
    bus.deliver = true;
    const listener = await listenProjectMemberChanges(handlers);
    expect(await listener.probe(50)).toBe(true);
  });

  it("answers false when the nonce never comes back", async () => {
    bus.deliver = false;
    const listener = await listenProjectMemberChanges(handlers);
    expect(await listener.probe(20)).toBe(false);
  });

  it("answers false for a probe still waiting when the listener stops", async () => {
    bus.deliver = false;
    const listener = await listenProjectMemberChanges(handlers);
    const pending = listener.probe(50);
    await listener.stop();
    expect(await pending).toBe(false);
  });
});
