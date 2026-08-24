// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Control-plane publish/subscribe namespacing (#1831).
 *
 * This module is the SINGLE place the deployment prefix is injected into
 * control channels: `@breatic/shared` builds the names but takes the prefix as
 * a parameter (it must stay browser-safe and cannot read env), so if this file
 * passes the wrong value — or the subscriber pattern stops agreeing with the
 * publishers — nothing else catches it.
 *
 * And the failure is silent in the worst way. A publisher writing to a channel
 * nobody is subscribed to throws nothing: `PUBLISH` to a channel with zero
 * subscribers is a valid Redis command returning 0. The symptom is "collab
 * stopped reacting to membership changes", days later, with no error anywhere.
 * Hence: assert the exact channel a publish lands on, and assert the pattern
 * the subscriber uses actually matches it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { publishMock, envMock } = vi.hoisted(() => ({
  publishMock: vi.fn(async () => 0),
  envMock: { REDIS_KEY_PREFIX: "dev" },
}));

vi.mock("@core/infra/redis.js", () => ({
  getStreamRedis: () => ({ publish: publishMock }),
}));

vi.mock("@core/config/runtime.js", () => ({ env: envMock }));

import {
  publishMembersChanged,
  publishActivityNew,
  projectControlChannelPattern,
} from "@core/infra/control-events.js";

const PID = "4d1a0d66-ee82-4596-986a-21054cd65490";

/**
 * Evaluate a Redis glob pattern the way `PSUBSCRIBE` does, for the `*` and
 * literal subset these patterns use.
 * @param pattern - The pattern passed to PSUBSCRIBE.
 * @param channel - A concrete channel name.
 * @returns Whether Redis would deliver that channel to that pattern.
 */
function patternMatches(pattern: string, channel: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(channel);
}

/**
 * The channel name the most recent publish call targeted.
 * @returns The channel string.
 */
function lastChannel(): string {
  const call = publishMock.mock.calls.at(-1) as unknown as [string, string];
  return call[0];
}

describe("control-events — deployment prefix", () => {
  beforeEach(() => {
    publishMock.mockClear();
    envMock.REDIS_KEY_PREFIX = "dev";
  });

  it("publishes members:changed on the prefixed channel", async () => {
    await publishMembersChanged(PID, { affectedUserId: "u1", action: "invite" });

    expect(lastChannel()).toBe(`dev:project:${PID}:members:changed`);
  });

  it("publishes activity:new on the prefixed channel", async () => {
    await publishActivityNew(PID);

    expect(lastChannel()).toBe(`dev:project:${PID}:activity:new`);
  });

  it("derives the subscribe pattern from the same prefix", () => {
    envMock.REDIS_KEY_PREFIX = "dev-agent";

    expect(projectControlChannelPattern()).toBe("dev-agent:project:*");
  });

  // The invariant that actually keeps the feature working: whatever prefix is
  // configured, the pattern the subscriber registers must match the channels
  // the publishers write. Publishing into the void is silent.
  it.each(["dev", "dev-agent", "staging", "prod"])(
    "with prefix %s the subscribe pattern matches what the publishers write",
    async (prefix) => {
      envMock.REDIS_KEY_PREFIX = prefix;
      const pattern = projectControlChannelPattern();

      await publishMembersChanged(PID, { affectedUserId: "u1", action: "invite" });
      expect(patternMatches(pattern, lastChannel())).toBe(true);

      await publishActivityNew(PID);
      expect(patternMatches(pattern, lastChannel())).toBe(true);
    },
  );

  // Two deployments must be deaf to each other — including the case where one
  // prefix is a string prefix of the other, which is exactly what "dev" and
  // "dev-agent" are.
  it("one deployment's pattern never matches another's channels", async () => {
    envMock.REDIS_KEY_PREFIX = "dev-agent";
    const theirs = projectControlChannelPattern();

    envMock.REDIS_KEY_PREFIX = "dev";
    await publishMembersChanged(PID, { affectedUserId: "u1", action: "invite" });

    expect(patternMatches(theirs, lastChannel())).toBe(false);
  });
});
