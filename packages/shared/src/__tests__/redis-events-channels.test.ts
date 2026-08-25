// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Control-plane pub/sub channel naming (#1831).
 *
 * These channels carry membership changes and Space CRUD commands — write
 * operations. Redis pub/sub ignores the DB number (SUBSCRIBE is instance-wide),
 * so two deployments sharing a Redis instance hear each other's control events
 * unless the channel names themselves are namespaced.
 *
 * The invariant that actually matters is not "the names contain a prefix" but
 * **the subscriber's pattern matches the publisher's channels, and matches
 * nothing from a different prefix**. Get that wrong in either direction and the
 * failure is silent: a pattern that is too narrow receives nothing (no error,
 * collab just stops reacting to membership changes), one that is too wide is
 * exactly the leak this change exists to close.
 */
import { describe, it, expect } from "vitest";
import {
  membersChangedChannel,
  activityNewChannel,
  allProjectChannelsPattern,
} from "../types/redis-events.js";

const PID = "4d1a0d66-ee82-4596-986a-21054cd65490";
const OTHER_PID = "6758483e-75bb-4285-84f1-a375438cfb1a";

/**
 * Evaluate a Redis glob pattern against a channel name the way `PSUBSCRIBE`
 * does, for the subset of the syntax these patterns use (`*` and literals).
 * @param pattern - The pattern passed to PSUBSCRIBE.
 * @param channel - A concrete channel name.
 * @returns Whether Redis would deliver that channel to that pattern.
 */
function patternMatches(pattern: string, channel: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(channel);
}

/**
 * The separator is the defence, not the position.
 *
 * Verified against a real Redis (2026-07-27): `PSUBSCRIBE dev*` DOES receive a
 * publish to `dev-agent:project:x:members:changed`, while `PSUBSCRIBE dev:*`
 * does NOT. So what stops `dev` from hearing `dev-agent` is the literal `:`
 * sitting between the prefix and the wildcard — a leading prefix with the
 * wildcard pressed straight against it would leak, and a TRAILING prefix
 * (`project:*:dev`) is equally safe. Pinning this here because the rule for any
 * future channel family follows from it: never let a wildcard touch the prefix.
 */
/**
 * These channel names are a WIRE FORMAT between two processes, and #1831
 * changed it: on the previous release these channels carried no prefix at all
 * (`project:{id}:members:changed`, pattern `project:*`), so an old-build
 * publisher and a new-build subscriber cannot hear each other. A publish that
 * matches no pattern is dropped by Redis with no error, which makes the break
 * silent — during a multi-replica rolling update, membership revocations do
 * not reach collab and a removed member keeps their open session.
 *
 * Pinned here so the cost of the NEXT rename is visible before it ships: any
 * change to these strings is a coordinated deploy, not a refactor.
 */
describe("control-plane channels — renaming these breaks cross-version pub/sub", () => {
  it("no longer matches the pre-#1831 unprefixed shape", () => {
    // The old wire format, spelled out so the break is explicit rather than
    // implied. An old-build publisher still emits exactly this.
    const oldChannel = `project:${PID}:members:changed`;
    const oldPattern = "project:*";

    expect(membersChangedChannel("prod", PID)).not.toBe(oldChannel);
    // New subscriber deaf to old publisher…
    expect(patternMatches(allProjectChannelsPattern("prod"), oldChannel)).toBe(false);
    // …and old subscriber deaf to new publisher. Both directions, both silent.
    expect(patternMatches(oldPattern, membersChangedChannel("prod", PID))).toBe(false);
  });
});

describe("control-plane channels — the separator is what isolates", () => {
  it("a wildcard pressed against the prefix would leak across deployments", () => {
    // Not how we build patterns — this is the counter-example the real rule
    // rests on. If this ever stops being true, the rationale above is wrong.
    expect(patternMatches("dev*", `dev-agent:project:${PID}:members:changed`)).toBe(true);
  });

  it("the literal separator after the prefix is what closes it", () => {
    expect(patternMatches("dev:*", `dev-agent:project:${PID}:members:changed`)).toBe(false);
    expect(patternMatches("dev:*", `dev:project:${PID}:members:changed`)).toBe(true);
  });

  it("every pattern this module builds keeps a literal separator before the wildcard", () => {
    for (const prefix of ["dev", "dev-agent", "dev_b", "staging2"]) {
      // `{prefix}:project:*` — the character right after the prefix must be a
      // literal, never `*`. This is the invariant, stated as an assertion.
      expect(allProjectChannelsPattern(prefix).startsWith(`${prefix}:`)).toBe(true);
      expect(allProjectChannelsPattern(prefix)).not.toBe(`${prefix}*`);
    }
  });
});

describe("control-plane channels — prefix namespacing", () => {
  it("puts the prefix at the front of every channel", () => {
    expect(membersChangedChannel("dev", PID)).toBe(
      `dev:project:${PID}:members:changed`,
    );
    expect(activityNewChannel("dev", PID)).toBe(
      `dev:project:${PID}:activity:new`,
    );
    expect(allProjectChannelsPattern("dev")).toBe("dev:project:*");
  });

  it("the subscribe pattern matches every channel the publishers write", () => {
    const pattern = allProjectChannelsPattern("dev-agent");

    expect(patternMatches(pattern, membersChangedChannel("dev-agent", PID))).toBe(
      true,
    );
    expect(patternMatches(pattern, activityNewChannel("dev-agent", PID))).toBe(
      true,
    );
    expect(
      patternMatches(pattern, membersChangedChannel("dev-agent", OTHER_PID)),
    ).toBe(true);
  });

  // The whole point of the change: one deployment's pattern must be deaf to
  // another deployment's channels, even for the same project UUID (which is
  // exactly what happens when two worktrees are seeded from one database dump).
  it("one deployment's pattern never matches another's channels", () => {
    const mine = allProjectChannelsPattern("dev-agent");

    expect(patternMatches(mine, membersChangedChannel("dev", PID))).toBe(false);
    expect(patternMatches(mine, membersChangedChannel("dev-studio", PID))).toBe(
      false,
    );
    expect(patternMatches(mine, activityNewChannel("dev-document", PID))).toBe(
      false,
    );
  });

  // `dev` must not swallow `dev-agent`: a prefix that is a string prefix of
  // another one would make the shorter deployment hear the longer one, which is
  // the subtlest way to reintroduce the leak.
  it("a prefix that is a string prefix of another does not swallow it", () => {
    expect(
      patternMatches(allProjectChannelsPattern("dev"), membersChangedChannel("dev-agent", PID)),
    ).toBe(false);
    expect(
      patternMatches(allProjectChannelsPattern("dev-agent"), membersChangedChannel("dev", PID)),
    ).toBe(false);
  });
});
