// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The chat stream's event names are defined once, in `@breatic/shared`, and
 * what the backend actually emits stays inside that set.
 *
 * The emitted side is read off the emit sites, never off the enum. Once
 * `SSEEventType` is the shared set, comparing the two enums would be
 * `expect(x).toEqual(x)` — a test that cannot fail, protecting nothing, while
 * the thing it claims to protect (contract matches reality) goes unwatched.
 *
 * The comparison is one-way: every emitted name must be in the contract, and
 * every contract name nothing emits must say so out loud in
 * `SSE_EVENTS_DECLARED_NOT_EMITTED`. `agent_thinking` is the one such name
 * today — declared for the thinking stream PR-3 batch 6 wires up, emitted by
 * nothing yet. Both directions are checked, so removing an emit site without
 * annotating it goes red just like adding an unlisted event does.
 *
 * The scanner refuses to guess. An emit site whose event name is not a
 * literal is only allowed if this file says where that name comes from;
 * anything else fails rather than being skipped, because a skipped emit site
 * reads exactly like a clean repo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";
import { SSE_EVENT_NAMES, SSE_EVENTS_DECLARED_NOT_EMITTED } from "@breatic/shared";

/** The file holding the agent turn loop — every event reaches the wire from here. */
const AGENT_LOOP = "packages/server/src/agent/main-agent.ts";

/**
 * Emit sites that pass a variable rather than a literal, mapped to the file
 * that decides the name. `interaction.event` is picked in the sentinel
 * table, one entry per interaction tool.
 */
const INDIRECT_SOURCES: ReadonlyMap<string, string> = new Map([
  ["interaction.event", "packages/server/src/agent/interaction-sentinel.ts"],
]);

/** Every `this.sse(<arg>, ...)` call, capturing the first argument. */
const EMIT_SITE = /this\.sse\(\s*([A-Za-z_$][\w$.]*)\s*,/g;

/** A member of the event enum, wherever it is written. */
const ENUM_MEMBER = /SSEEventType\.([A-Z_]+)/g;

/**
 * Read a repo file.
 * @param relPath - Path relative to the monorepo root.
 * @returns The file's text.
 * @throws {Error} When the file is missing.
 */
function read(relPath: string): string {
  return readFileSync(join(MONOREPO_ROOT, relPath), "utf-8");
}

/**
 * Resolve enum keys to their wire values.
 * @param keys - Enum member names such as `CHAT_CHUNK`.
 * @returns The wire names, sorted.
 * @throws {Error} When a key is not in the shared contract.
 */
function toWireNames(keys: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const key of keys) {
    const value = (SSE_EVENT_NAMES as Record<string, string | undefined>)[key];
    if (value === undefined) {
      throw new Error(`emit site names SSEEventType.${key}, which the shared contract does not declare`);
    }
    names.add(value);
  }
  return [...names].sort();
}

/**
 * The text a match captured.
 *
 * Every pattern here has exactly one group, so an absent capture means the
 * pattern was edited into something that no longer captures — which would
 * otherwise hand this scan an empty result and read as a clean repo.
 * @param m - A match from one of the patterns above.
 * @returns The captured text.
 * @throws {Error} When the pattern captured nothing.
 */
function captured(m: RegExpMatchArray): string {
  const group = m[1];
  if (group === undefined) {
    throw new Error(`a matcher lost its capture group while matching: ${m[0]}`);
  }
  return group;
}

/**
 * Every first argument passed to `this.sse(...)` in a source.
 * @param source - The file's text.
 * @returns The argument expressions, in order.
 * @throws {Error} When the matcher stops capturing.
 */
function emitSiteArgs(source: string): string[] {
  return [...source.matchAll(EMIT_SITE)].map(captured);
}

/**
 * Collect the event names the backend can actually put on the wire.
 * @returns The emitted wire names, sorted.
 * @throws {Error} When an emit site's name cannot be traced to a declaration.
 */
function emittedNames(): string[] {
  const keys = new Set<string>();

  const sites = emitSiteArgs(read(AGENT_LOOP));
  expect(sites.length, "the scanner found no emit sites at all").toBeGreaterThan(0);

  for (const arg of sites) {
    const literal = /^SSEEventType\.([A-Z_]+)$/.exec(arg);
    if (literal) {
      keys.add(captured(literal));
      continue;
    }
    const source = INDIRECT_SOURCES.get(arg);
    if (source === undefined) {
      throw new Error(
        `this.sse(${arg}, ...) passes a name this scan cannot trace. Add it to INDIRECT_SOURCES with the file that decides it.`,
      );
    }
    for (const m of read(source).matchAll(ENUM_MEMBER)) keys.add(captured(m));
  }

  return toWireNames(keys);
}

/** Sources the emit-site matcher must catch, and sources it must leave alone. */
const SAMPLES: ReadonlyArray<{ source: string; found: string[]; why: string }> = [
  { source: `yield this.sse(SSEEventType.CHAT_CHUNK, { text });`, found: ["SSEEventType.CHAT_CHUNK"], why: "the ordinary case" },
  { source: `return this.sse(SSEEventType.ERROR, {\n  message,\n});`, found: ["SSEEventType.ERROR"], why: "argument on the next line" },
  { source: `yield this.sse( SSEEventType.CHAT_DONE , {});`, found: ["SSEEventType.CHAT_DONE"], why: "spaces around the name" },
  { source: `yield this.sse(interaction.event, interaction.payload);`, found: ["interaction.event"], why: "a variable, which must be traceable" },
  { source: `private sse(event: SSEEventType, data: X): SSEEvent {`, found: [], why: "the method's own declaration is not a call" },
  { source: `const x = other.sse(SSEEventType.ERROR, {});`, found: [], why: "some other object's method" },
];

describe("the chat stream's event contract", () => {
  it.each(SAMPLES)("emit-site matcher: $why", ({ source, found }) => {
    expect(emitSiteArgs(source)).toEqual(found);
  });

  it("every name the backend emits is declared in the shared contract", () => {
    const declared = new Set<string>(Object.values(SSE_EVENT_NAMES));
    const undeclared = emittedNames().filter((n) => !declared.has(n));
    expect(undeclared).toEqual([]);
  });

  it("every declared name that nothing emits says so", () => {
    const emitted = new Set(emittedNames());
    const silent = Object.values(SSE_EVENT_NAMES).filter((n) => !emitted.has(n)).sort();
    expect(silent).toEqual(Object.keys(SSE_EVENTS_DECLARED_NOT_EMITTED).sort());
  });

  it("nothing is annotated as unemitted while an emit site exists for it", () => {
    const emitted = new Set(emittedNames());
    const stale = Object.keys(SSE_EVENTS_DECLARED_NOT_EMITTED).filter((n) => emitted.has(n));
    expect(stale).toEqual([]);
  });

  // That an annotated name is a real one is settled by the type — the record
  // is keyed on `SSEEventName`, so a typo does not compile. What the type
  // cannot say is that the reason says anything.
  it("every annotation carries a reason", () => {
    for (const [name, why] of Object.entries(SSE_EVENTS_DECLARED_NOT_EMITTED)) {
      expect(why?.trim(), `${name} is annotated with no reason`).toBeTruthy();
    }
  });

  it("today that is agent_thinking and nothing else", () => {
    expect(Object.keys(SSE_EVENTS_DECLARED_NOT_EMITTED)).toEqual([SSE_EVENT_NAMES.AGENT_THINKING]);
  });
});
