// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENT_NAMES, sanitizeEventProperties } from "../analytics/events.js";

describe("ANALYTICS_EVENT_NAMES", () => {
  it("lists the issue's eighteen events and the two failure events", () => {
    expect([...ANALYTICS_EVENT_NAMES].sort()).toEqual(
      [
        "landing_viewed", "signup_started", "signup_completed", "signup_failed", "login_completed",
        "pricing_viewed", "project_created", "space_created", "first_agent_action_completed",
        "first_generation_completed", "member_invited", "invitation_accepted", "collaborator_first_action",
        "active_project_session", "credit_purchase_completed", "credit_purchase_failed",
        "subscription_started", "subscription_renewed", "subscription_cancelled", "refund_completed",
      ].sort(),
    );
  });
});

describe("sanitizeEventProperties", () => {
  it("keeps the invitation id on both invitation events", () => {
    for (const name of ["member_invited", "invitation_accepted"] as const) {
      expect(sanitizeEventProperties(name, { studio_id: "s1", scope: "studio", role: "guest", invitation_id: "i1" }))
        .toMatchObject({ invitation_id: "i1" });
    }
  });

  it("keeps the shared properties and the event's own", () => {
    expect(
      sanitizeEventProperties("project_created", {
        app_version: "0.0.9", language: "zh-CN", membership_tier: "pro", success: true,
        studio_id: "s1", project_id: "p1", space_type: "canvas", via: "new", is_first: true,
      }),
    ).toEqual({
      app_version: "0.0.9", language: "zh-CN", membership_tier: "pro", success: true,
      studio_id: "s1", project_id: "p1", space_type: "canvas", via: "new", is_first: true,
    });
  });

  it("drops properties the event does not list", () => {
    expect(
      sanitizeEventProperties("signup_completed", {
        method: "google", email: "a@b.c", prompt: "draw a cat", project_id: "p1",
      }),
    ).toEqual({ method: "google" });
  });

  it("drops values whose type does not match", () => {
    expect(
      sanitizeEventProperties("credit_purchase_completed", {
        credits: "lots", amount_cents: 1200, currency: "usd", success: "yes",
      }),
    ).toEqual({ amount_cents: 1200, currency: "usd" });
  });

  it("cuts long strings to 200 characters", () => {
    const out = sanitizeEventProperties("signup_failed", { error_code: "x".repeat(500) });
    expect(out?.error_code).toHaveLength(200);
  });

  it("keeps only the path of a page address", () => {
    expect(
      sanitizeEventProperties("landing_viewed", {
        landing_page: "https://example.com/pricing/?gclid=abc&email=a%40b.c#top",
      }),
    ).toEqual({ landing_page: "/pricing/" });
    expect(sanitizeEventProperties("landing_viewed", { landing_page: "/ja/?utm_source=x" })).toEqual({
      landing_page: "/ja/",
    });
  });

  it("refuses an event that is not in the list", () => {
    expect(sanitizeEventProperties("page_viewed" as never, { a: 1 })).toBeNull();
  });
});
