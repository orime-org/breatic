// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { type AccountConsent, mergeAccountConsent } from "../analytics/account-consent.js";
import { CONSENT_REVISION } from "../analytics/consent.js";

const at = (iso: string): AccountConsent["decidedAt"] => iso;

function choice(analytics: boolean, ads: boolean, decidedAt: string, revision = CONSENT_REVISION): AccountConsent {
  return { analytics, ads, decidedAt: at(decidedAt), source: "banner", revision };
}

describe("mergeAccountConsent", () => {
  it("stores the first report on an empty account", () => {
    const incoming = choice(true, false, "2026-10-12T09:00:00.000Z");
    expect(mergeAccountConsent(null, incoming)).toEqual(incoming);
  });

  it("takes a report decided later", () => {
    const stored = choice(true, true, "2026-10-12T09:00:00.000Z");
    const later = choice(false, false, "2026-10-12T10:00:00.000Z");
    expect(mergeAccountConsent(stored, later)).toEqual(later);
  });

  it("keeps the stored choice when the report was decided earlier", () => {
    const stored = choice(false, false, "2026-10-12T10:00:00.000Z");
    const earlier = choice(true, true, "2026-10-12T09:00:00.000Z");
    expect(mergeAccountConsent(stored, earlier)).toEqual(stored);
  });

  it("resolves a tie by refusing each category either side refused", () => {
    const stored = choice(true, false, "2026-10-12T09:00:00.000Z");
    const same = choice(false, true, "2026-10-12T09:00:00.000Z");
    expect(mergeAccountConsent(stored, same)).toMatchObject({ analytics: false, ads: false });
  });

  it("ignores a report made under an older revision", () => {
    const stored = choice(true, true, "2026-10-12T09:00:00.000Z");
    const outdated = choice(false, false, "2026-10-12T10:00:00.000Z", CONSENT_REVISION - 1);
    expect(mergeAccountConsent(stored, outdated)).toEqual(stored);
    expect(mergeAccountConsent(null, outdated)).toBeNull();
  });

  it("ignores a report whose decision time is not a valid date", () => {
    const stored = choice(true, true, "2026-10-12T09:00:00.000Z");
    expect(mergeAccountConsent(stored, choice(false, false, "yesterday"))).toEqual(stored);
  });
});
