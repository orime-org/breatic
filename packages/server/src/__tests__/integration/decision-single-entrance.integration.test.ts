// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One entrance for answering a request — enforced on the route table itself.
 *
 * The unification's core claim is structural: there is exactly one place a
 * waiting request can be answered, so its gates cannot be out of step with a
 * second door's. The four routes that used to be that second door each died at
 * a different time, and two of them were found alive AFTER the round that
 * claimed to have removed them — deletion by grep does not stay deleted.
 * This suite pins the claim to Hono's own route table, so a resurrected door
 * fails a test instead of waiting for the next audit.
 */

import { describe, it, expect, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import { initCore } from "@breatic/core";

initCore(process.env);

const { createApp } = await import("@server/app.js");
const app = createApp();

/**
 * Whether any registered route matches the given method and a path fragment.
 * @param method - HTTP method to look for.
 * @param fragment - Substring the route's combined path must contain.
 * @returns True when at least one route matches.
 */
function hasRoute(method: string, fragment: string): boolean {
  return app.routes.some(
    (r) => r.method === method && r.path.includes(fragment),
  );
}

describe("answering happens through exactly one pair of routes", () => {
  it("the decision endpoints exist", () => {
    expect(hasRoute("GET", "/decisions/:token")).toBe(true);
    expect(hasRoute("POST", "/decisions/respond")).toBe(true);
  });

  // The four second doors, each pinned by the shape it had when it was alive.
  const DEAD_DOORS = [
    // The bell's inline confirm/cancel, deleted in round 1 of Gate 2.
    ["POST", "/notifications/:id/action"],
    // The two invite landing pages' own respond endpoints.
    ["POST", "/studio-invitations/respond"],
    ["POST", "/project-invitations/respond"],
    // The role-upgrade decision endpoint — row 4 of the design's deletion
    // table, still alive after round 1 claimed the table done. The parameter
    // was named for the notification, not the request: this door addressed
    // the bell entry, which is what made it a second entrance in the first
    // place. Spelling it any other way pins nothing, since the match is a
    // substring of the registered path.
    ["PATCH", "/role-upgrade-requests/:notificationId/decision"],
  ] as const;

  it.each(DEAD_DOORS)("%s %s is not routed", (method, fragment) => {
    expect(hasRoute(method, fragment)).toBe(false);
  });

  it("withdrawal survives — it is the asker's own action, not an answer", () => {
    // `DELETE /role-upgrade-requests/:requestId` lets the REQUESTER take their
    // request back. The unification covers answering; taking back stays.
    expect(hasRoute("DELETE", "/role-upgrade-requests/:requestId")).toBe(true);
  });
});
