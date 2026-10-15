// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every run-once request is throttled before it is claimed (inner#1490).
 *
 * Each new key leaves a record in Redis DB0 that is kept for the scope's
 * retention, so a request sent in a loop with a fresh key each time grows
 * that database unless the route caps it first.
 */

import { describe, it, expect, vi } from "vitest";
import type { Hono } from "hono";
import type { AuthVariables } from "@server/middleware/auth.js";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));
vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../../__tests__/helpers/mock-core.js");
  return coreMock(importOriginal);
});
vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../../__tests__/helpers/mock-core.js");
  return domainMock();
});
vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../../__tests__/helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});
vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: (action: string) =>
    Object.assign(() => undefined, { throttles: action }),
}));
vi.mock("@server/middleware/run-once.js", () => ({
  runOnce: (scope: string) => Object.assign(() => undefined, { runsOnce: scope }),
}));

import { canvasRoute } from "@server/routes/canvas.js";
import { chatRoute } from "@server/routes/chat.js";
import { miniToolsRoute } from "@server/routes/mini-tools.js";
import { paymentRoute } from "@server/routes/payment.js";
import { projectsRoute } from "@server/routes/projects.js";
import { subscriptionRoute } from "@server/routes/subscription.js";

/** A route handler as the mocks above tag it. */
type Tagged = { throttles?: string; runsOnce?: string };

/**
 * For each run-once route: whether a throttle runs before the claim, counting
 * the router's own `use()` middleware registered ahead of it.
 * @param route - The router.
 * @returns `METHOD path` to whether it is throttled first.
 */
function throttledFirst(route: Hono<{ Variables: AuthVariables }>): Map<string, boolean> {
  const shared: Tagged[] = [];
  const handlers = new Map<string, Tagged[]>();
  for (const r of route.routes) {
    const handler = r.handler as Tagged;
    if (r.method === "ALL" && (r.path === "*" || r.path === "/*")) {
      shared.push(handler);
      continue;
    }
    const name = `${r.method} ${r.path}`;
    handlers.set(name, [...(handlers.get(name) ?? [...shared]), handler]);
  }
  const found = new Map<string, boolean>();
  for (const [name, list] of handlers) {
    const claim = list.findIndex((h) => h.runsOnce !== undefined);
    if (claim < 0) continue;
    found.set(name, list.slice(0, claim).some((h) => h.throttles !== undefined));
  }
  return found;
}

describe("run-once routes", () => {
  it("are each throttled before the claim", () => {
    const routers = {
      canvas: canvasRoute,
      chat: chatRoute,
      miniTools: miniToolsRoute,
      payment: paymentRoute,
      projects: projectsRoute,
      subscription: subscriptionRoute,
    };
    const all = new Map(
      Object.entries(routers).flatMap(([router, route]) =>
        [...throttledFirst(route)].map(
          ([name, first]) => [`${router} ${name}`, first] as const,
        ),
      ),
    );
    expect(all.size).toBe(8);
    expect([...all].filter(([, first]) => !first).map(([name]) => name)).toEqual([]);
  });
});
