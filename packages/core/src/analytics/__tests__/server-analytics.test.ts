// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AnalyticsClient,
  initServerAnalytics,
  resetServerAnalyticsForTest,
  serverAnalyticsWanted,
  trackServerEvent,
} from "@core/analytics/server-analytics.js";
import { runWithConsent } from "@core/analytics/consent-context.js";

const KEY = "0123456789abcdef0123456789abcdef";

function fakeClient(): AnalyticsClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    track: vi.fn((event) => {
      sent.push(event);
    }),
    flush: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  resetServerAnalyticsForTest();
});

describe("initServerAnalytics", () => {
  it("stays off without a key", () => {
    const client = fakeClient();
    expect(initServerAnalytics({ apiKey: "", createClient: () => client })).toBe("off");
    trackServerEvent("signup_completed", { userId: "u-12345", insertId: "signup:u-12345", properties: {} }, { analytics: true, ads: true });
    expect(client.sent).toEqual([]);
  });

  it("refuses a key that is not an Amplitude key", () => {
    const client = fakeClient();
    expect(initServerAnalytics({ apiKey: "not-a-key", createClient: () => client })).toBe("invalid");
    trackServerEvent("signup_completed", { userId: "u-12345", insertId: "signup:u-12345", properties: {} }, { analytics: true, ads: true });
    expect(client.sent).toEqual([]);
  });

  it("starts with a well-formed key", () => {
    expect(initServerAnalytics({ apiKey: KEY, createClient: () => fakeClient() })).toBe("started");
  });
});

describe("trackServerEvent", () => {
  it("sends the event with the user, the dedupe id and the whitelisted properties", () => {
    const client = fakeClient();
    initServerAnalytics({ apiKey: KEY, createClient: () => client });
    trackServerEvent(
      "project_created",
      { userId: "u-12345", insertId: "project:p1", properties: { project_id: "p1", prompt: "secret" } },
      { analytics: true, ads: false },
    );
    expect(client.sent).toEqual([
      {
        event_type: "project_created",
        user_id: "u-12345",
        insert_id: "project:p1",
        event_properties: { project_id: "p1" },
      },
    ]);
  });

  it("sends nothing when the browser declined analytics", () => {
    const client = fakeClient();
    initServerAnalytics({ apiKey: KEY, createClient: () => client });
    trackServerEvent("project_created", { userId: "u-12345", insertId: "project:p1", properties: {} }, { analytics: false, ads: true });
    expect(client.sent).toEqual([]);
  });

  it("uses the request's consent when no snapshot is passed", async () => {
    const client = fakeClient();
    initServerAnalytics({ apiKey: KEY, createClient: () => client });
    await runWithConsent({ analytics: true, ads: false }, async () => {
      trackServerEvent("login_completed", { userId: "u-12345", insertId: "login:1", properties: {} });
    });
    trackServerEvent("login_completed", { userId: "u-12345", insertId: "login:2", properties: {} });
    expect(client.sent).toHaveLength(1);
  });

  it("says whether an event would leave", () => {
    expect(serverAnalyticsWanted({ analytics: true, ads: true })).toBe(false);
    initServerAnalytics({ apiKey: KEY, createClient: () => fakeClient() });
    expect(serverAnalyticsWanted({ analytics: true, ads: false })).toBe(true);
    expect(serverAnalyticsWanted({ analytics: false, ads: true })).toBe(false);
  });

  it("drops an event Amplitude would reject for a short user id", () => {
    const client = fakeClient();
    initServerAnalytics({ apiKey: KEY, createClient: () => client });
    trackServerEvent("login_completed", { userId: "u1", insertId: "login:3", properties: {} }, { analytics: true, ads: false });
    expect(client.sent).toEqual([]);
  });
});
