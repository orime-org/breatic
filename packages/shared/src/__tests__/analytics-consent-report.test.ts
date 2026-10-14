// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { ConsentReportSchema } from "../analytics/consent-report.js";
import { CONSENT_REVISION } from "../analytics/consent.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const AT = "2026-10-14T00:00:00.000Z";

function decision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionId: ID_A,
    category: "ads",
    value: true,
    source: "banner",
    noticeShown: false,
    gpcAtDecision: false,
    decidedAt: AT,
    ...over,
  };
}

function report(decisions: Record<string, unknown>[], extra: Record<string, unknown> = {}): unknown {
  return { decisions, revision: CONSENT_REVISION, sentAt: AT, ...extra };
}

const ok = (body: unknown): boolean => ConsentReportSchema.safeParse(body).success;

describe("ConsentReportSchema", () => {
  it("accepts one decision per category", () => {
    expect(ok(report([decision(), decision({ decisionId: ID_B, category: "analytics" })]))).toBe(true);
  });

  it("accepts a settings override and a GPC refusal of ads", () => {
    expect(ok(report([decision({ source: "settings", noticeShown: "account" })]))).toBe(true);
    expect(ok(report([decision({ source: "gpc", value: false, gpcAtDecision: true })]))).toBe(true);
  });

  it("rejects a missing or malformed decisionId", () => {
    expect(ok(report([decision({ decisionId: undefined })]))).toBe(false);
    expect(ok(report([decision({ decisionId: "not-a-uuid" })]))).toBe(false);
  });

  it("rejects a regional default and an operator request", () => {
    expect(ok(report([decision({ source: "implicit" })]))).toBe(false);
    expect(ok(report([decision({ source: "request", value: false })]))).toBe(false);
  });

  it("rejects a GPC decision that is not an ads refusal", () => {
    expect(ok(report([decision({ source: "gpc", value: true })]))).toBe(false);
    expect(ok(report([decision({ source: "gpc", value: false, category: "analytics" })]))).toBe(false);
  });

  it("rejects a notice outside an ads choice made in settings", () => {
    expect(ok(report([decision({ noticeShown: "account" })]))).toBe(false);
    expect(ok(report([decision({ category: "analytics", source: "settings", noticeShown: "gpc" })]))).toBe(false);
  });

  it("rejects a repeated decisionId within one report", () => {
    expect(ok(report([decision(), decision({ category: "analytics" })]))).toBe(false);
  });

  it("rejects an empty report", () => {
    expect(ok(report([]))).toBe(false);
  });
});
