// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { type AccountConsent, accountConsentCurrent, mergeAccountConsent } from "../analytics/account-consent.js";
import { CONSENT_MAX_AGE_DAYS, CONSENT_REVISION } from "../analytics/consent.js";

const at = (iso: string): AccountConsent["decidedAt"] => iso;

function choice(
  analytics: boolean,
  ads: boolean,
  decidedAt: string,
  revision = CONSENT_REVISION,
  source: AccountConsent["source"] = "banner",
): AccountConsent {
  return { analytics, ads, decidedAt: at(decidedAt), source, revision };
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

  it("never lets a default the person did not choose change the account", () => {
    const rejected = choice(false, false, "2026-10-12T09:00:00.000Z");
    const implicit = choice(true, true, "2026-10-13T09:00:00.000Z", CONSENT_REVISION, "implicit");
    expect(mergeAccountConsent(rejected, implicit)).toEqual(rejected);
    expect(mergeAccountConsent(null, implicit)).toBeNull();
  });

  it("lets Global Privacy Control withdraw ads from the account's choice and nothing else", () => {
    const stored = choice(true, true, "2026-10-12T09:00:00.000Z");
    const gpc = choice(true, false, "2026-10-13T09:00:00.000Z", CONSENT_REVISION, "gpc");
    expect(mergeAccountConsent(stored, gpc)).toEqual({ ...stored, ads: false });
  });

  it("never lets Global Privacy Control grant analytics the person refused or never chose", () => {
    const rejected = choice(false, false, "2026-10-12T09:00:00.000Z");
    const gpc = choice(true, false, "2026-10-13T09:00:00.000Z", CONSENT_REVISION, "gpc");
    expect(mergeAccountConsent(rejected, gpc)).toEqual(rejected);
    expect(mergeAccountConsent(null, gpc)).toBeNull();
  });
});

describe("accountConsentCurrent", () => {
  const day = 24 * 60 * 60 * 1000;
  const decided = "2026-01-01T00:00:00.000Z";

  it("keeps a choice for as long as the consent cookie lasts", () => {
    const now = Date.parse(decided) + (CONSENT_MAX_AGE_DAYS - 1) * day;
    expect(accountConsentCurrent(choice(true, true, decided), now)).toEqual(choice(true, true, decided));
  });

  it("drops a choice older than the consent cookie lasts", () => {
    const now = Date.parse(decided) + (CONSENT_MAX_AGE_DAYS + 1) * day;
    expect(accountConsentCurrent(choice(true, true, decided), now)).toBeNull();
  });

  it("drops a choice made under an older revision", () => {
    expect(accountConsentCurrent(choice(true, true, decided, CONSENT_REVISION - 1), Date.parse(decided))).toBeNull();
  });

  it("treats nothing stored as no choice", () => {
    expect(accountConsentCurrent(null, Date.parse(decided))).toBeNull();
  });
});
