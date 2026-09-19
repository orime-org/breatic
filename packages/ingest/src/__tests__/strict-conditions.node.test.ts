// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Judging the two strict preconditions against the copy R2 described.
 *
 * R2 evaluates all four conditional headers itself and answers body-less
 * whichever one failed, so this is what decides whether that silence is a 412
 * or a 304. Every term is exercised here against supplied values — including
 * a copy written exactly on a whole second, the one case a stored object
 * cannot be made to produce on demand, and the only one where this judgement
 * compares two equal numbers.
 */

import { describe, it, expect } from "vitest";
import { strictConditionFailed } from "@ingest/download.js";

const ETAG = '"0ee0646c1c77d8131cc8f4ee65c7673b"';
/** 2026-09-18T11:40:52.000Z — a whole second, so a named date can equal it. */
const ON_THE_SECOND = 1789731652000;

/** One stored copy, as R2 would have described it. */
function copy(uploadedMs = ON_THE_SECOND + 819): {
  httpEtag: string;
  uploaded: Date;
} {
  return { httpEtag: ETAG, uploaded: new Date(uploadedMs) };
}

/** The request's headers, from the conditional ones it carries. */
function asking(conditions: Record<string, string>): Headers {
  return new Headers(conditions);
}

describe("If-Match settles it alone when present", () => {
  it("fails when it names another copy", () => {
    expect(
      strictConditionFailed(asking({ "if-match": '"another"' }), copy()),
    ).toBe(true);
  });

  it("passes when it names this copy", () => {
    expect(strictConditionFailed(asking({ "if-match": ETAG }), copy())).toBe(
      false,
    );
  });

  it("passes on * , which asks for the copy whatever it is", () => {
    expect(strictConditionFailed(asking({ "if-match": "*" }), copy())).toBe(
      false,
    );
  });

  it("reads a list, spaces and all", () => {
    expect(
      strictConditionFailed(
        asking({ "if-match": `"another", ${ETAG}` }),
        copy(),
      ),
    ).toBe(false);
  });

  // RFC 9110 §13.2.2 reaches the date only when If-Match is absent.
  it("ignores an If-Unmodified-Since the copy would fail", () => {
    expect(
      strictConditionFailed(
        asking({
          "if-match": ETAG,
          "if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT",
        }),
        copy(),
      ),
    ).toBe(false);
  });
});

describe("If-Unmodified-Since, on the terms R2 compares", () => {
  it("passes when the copy is older than the named moment", () => {
    expect(
      strictConditionFailed(
        asking({ "if-unmodified-since": new Date(ON_THE_SECOND + 2000).toUTCString() }),
        copy(),
      ),
    ).toBe(false);
  });

  it("fails when the copy is newer than the named moment", () => {
    expect(
      strictConditionFailed(
        asking({ "if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT" }),
        copy(),
      ),
    ).toBe(true);
  });

  // R2 passes only while `uploaded < limit`, so a copy written at the named
  // instant is one it refuses. An HTTP date carries whole seconds, so this is
  // reachable whenever the copy was written on one.
  it("fails when the copy was written at the named moment", () => {
    expect(
      strictConditionFailed(
        asking({
          "if-unmodified-since": new Date(ON_THE_SECOND).toUTCString(),
        }),
        copy(ON_THE_SECOND),
      ),
    ).toBe(true);
  });

  it("fails when the copy was written later in the named second", () => {
    expect(
      strictConditionFailed(
        asking({
          "if-unmodified-since": new Date(ON_THE_SECOND).toUTCString(),
        }),
        copy(ON_THE_SECOND + 819),
      ),
    ).toBe(true);
  });

  it("fails on a date it cannot read, which R2 refused rather than waived", () => {
    expect(
      strictConditionFailed(asking({ "if-unmodified-since": "whenever" }), copy()),
    ).toBe(true);
  });
});

describe("neither header present", () => {
  it("leaves the silence to the other two conditions", () => {
    expect(strictConditionFailed(asking({}), copy())).toBe(false);
  });
});
